#define _DARWIN_C_SOURCE

#include <errno.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

// Exported by libsystem_kernel on macOS. A launchd job receives a resource
// coalition, and every descendant remains a member even after setsid() or
// reparenting. This gives us a kernel-owned membership list without scanning
// the system process table.
typedef int (*coalition_pid_list_fn)(uint64_t coalition_id, void *buffer, size_t *buffer_size);

static volatile sig_atomic_t stop_requested = 0;
static void request_stop(int signal_number) { (void)signal_number; stop_requested = 1; }

static bool launch_authorized(void) {
  const char *raw_fd = getenv("OUTRIGHT_LAUNCH_GATE_FD");
  if (raw_fd == NULL) return true;
  char *end = NULL;
  long descriptor = strtol(raw_fd, &end, 10);
  unsetenv("OUTRIGHT_LAUNCH_GATE_FD");
  if (end == raw_fd || *end != '\0' || descriptor < 3 || descriptor > 1024) return false;
  char authorization[3];
  size_t used = 0;
  while (used < sizeof(authorization)) {
    ssize_t count = read((int)descriptor, authorization + used, sizeof(authorization) - used);
    if (count > 0) { used += (size_t)count; continue; }
    if (count < 0 && errno == EINTR) continue;
    close((int)descriptor);
    return false;
  }
  close((int)descriptor);
  return memcmp(authorization, "go\n", sizeof(authorization)) == 0;
}

static int wait_for(pid_t pid) {
  int status = 0;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) return -1;
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

static int run_launchctl(char *const arguments[], char *output, size_t output_capacity) {
  int pipe_fds[2] = { -1, -1 };
  if (output != NULL && pipe(pipe_fds) != 0) return -1;
  pid_t child = fork();
  if (child < 0) {
    if (pipe_fds[0] >= 0) { close(pipe_fds[0]); close(pipe_fds[1]); }
    return -1;
  }
  if (child == 0) {
    if (pipe_fds[1] >= 0) {
      close(pipe_fds[0]);
      dup2(pipe_fds[1], STDOUT_FILENO);
      dup2(pipe_fds[1], STDERR_FILENO);
      close(pipe_fds[1]);
    } else {
      int null_fd = open("/dev/null", O_WRONLY);
      if (null_fd >= 0) { dup2(null_fd, STDOUT_FILENO); dup2(null_fd, STDERR_FILENO); close(null_fd); }
    }
    execv("/bin/launchctl", arguments);
    _exit(127);
  }

  size_t used = 0;
  if (pipe_fds[0] >= 0) {
    close(pipe_fds[1]);
    for (;;) {
      char buffer[4096];
      ssize_t count = read(pipe_fds[0], buffer, sizeof(buffer));
      if (count > 0) {
        if (output_capacity > 0 && used < output_capacity - 1) {
          size_t available = output_capacity - 1 - used;
          size_t copy = (size_t)count < available ? (size_t)count : available;
          memcpy(output + used, buffer, copy);
          used += copy;
        }
        continue;
      }
      if (count < 0 && errno == EINTR) continue;
      break;
    }
    close(pipe_fds[0]);
    if (output_capacity > 0) output[used] = '\0';
  }
  return wait_for(child);
}

static bool valid_label(const char *label) {
  if (label == NULL || strncmp(label, "com.21n.outright.", 17) != 0) return false;
  size_t length = strlen(label);
  if (length < 18 || length > 120) return false;
  for (const char *cursor = label; *cursor; cursor++) {
    char value = *cursor;
    if (!((value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z')
      || (value >= '0' && value <= '9') || value == '.' || value == '-')) return false;
  }
  return true;
}

static bool output_pipe_path(char *path, size_t capacity, const char *label, const char *stream) {
  int written = snprintf(path, capacity, "/tmp/outright-agent-%s-%s.fifo", label, stream);
  return written > 0 && (size_t)written < capacity;
}

static void cleanup_output_pipe(const char *label, const char *stream) {
  char path[256];
  struct stat details;
  if (!output_pipe_path(path, sizeof(path), label, stream)) return;
  if (lstat(path, &details) == 0 && S_ISFIFO(details.st_mode) && details.st_uid == getuid()) unlink(path);
}

static void cleanup_output_pipes(const char *label) {
  cleanup_output_pipe(label, "stdout");
  cleanup_output_pipe(label, "stderr");
}

static int create_output_pipe(char *path, size_t capacity, const char *label, const char *stream) {
  if (!output_pipe_path(path, capacity, label, stream) || mkfifo(path, 0600) != 0) return -1;
  int fd = open(path, O_RDONLY | O_NONBLOCK);
  if (fd < 0) { unlink(path); return -1; }
  fcntl(fd, F_SETFD, FD_CLOEXEC);
  return fd;
}

static char *service_target(const char *label) {
  size_t capacity = strlen(label) + 32;
  char *target = calloc(capacity, 1);
  if (target != NULL) snprintf(target, capacity, "gui/%u/%s", getuid(), label);
  return target;
}

static void relay(int fd, int destination) {
  size_t relayed = 0;
  const size_t relay_budget = 256 * 1024;
  while (relayed < relay_budget) {
    char buffer[8192];
    size_t remaining = relay_budget - relayed;
    ssize_t count = read(fd, buffer, remaining < sizeof(buffer) ? remaining : sizeof(buffer));
    if (count > 0) {
      ssize_t written = 0;
      while (written < count) {
        ssize_t next = write(destination, buffer + written, (size_t)(count - written));
        if (next > 0) { written += next; relayed += (size_t)next; continue; }
        if (next < 0 && errno == EINTR && !stop_requested) continue;
        return;
      }
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    return;
  }
}

static void bootout(const char *target) {
  char *arguments[] = { "launchctl", "bootout", (char *)target, NULL };
  run_launchctl(arguments, NULL, 0);
}

typedef struct {
  int active;
  int runs;
  int exit_code;
  uint64_t resource_coalition_id;
} service_state;

typedef enum { SERVICE_OK, SERVICE_MISSING, SERVICE_ERROR } service_result;

static service_result read_state(const char *target, service_state *state) {
  char output[65536] = { 0 };
  char *arguments[] = { "launchctl", "print", (char *)target, NULL };
  int status = run_launchctl(arguments, output, sizeof(output));
  if (status != 0) {
    if (strstr(output, "Could not find service") != NULL
      || strstr(output, "Could not find specified service") != NULL
      || strstr(output, "service not found") != NULL) return SERVICE_MISSING;
    return SERVICE_ERROR;
  }
  state->active = -1;
  state->runs = -1;
  state->exit_code = 1;
  state->resource_coalition_id = 0;
  char *resource = strstr(output, "resource coalition = {");
  char *coalition_id = resource == NULL ? NULL : strstr(resource, "ID = ");
  if (coalition_id != NULL) state->resource_coalition_id = strtoull(coalition_id + 5, NULL, 10);
  for (char *line = strtok(output, "\n"); line != NULL; line = strtok(NULL, "\n")) {
    char *value;
    if ((value = strstr(line, "active count = ")) != NULL && state->active < 0) state->active = atoi(value + 15);
    else if ((value = strstr(line, "runs = ")) != NULL) state->runs = atoi(value + 7);
    else if ((value = strstr(line, "last exit code = ")) != NULL) state->exit_code = atoi(value + 17);
  }
  return state->active >= 0 ? SERVICE_OK : SERVICE_ERROR;
}

static int coalition_members(uint64_t coalition_id, pid_t *pids, size_t capacity) {
  static coalition_pid_list_fn list_pids = NULL;
  static bool resolved = false;
  if (!resolved) {
    list_pids = (coalition_pid_list_fn)dlsym(RTLD_DEFAULT, "coalition_info_pid_list");
    resolved = true;
  }
  size_t size = capacity * sizeof(*pids);
  if (coalition_id == 0 || list_pids == NULL || list_pids(coalition_id, pids, &size) != 0) return -1;
  return (int)(size / sizeof(*pids));
}

static bool terminate_coalition(const char *target, uint64_t coalition_id) {
  for (int attempt = 0; attempt < 100; attempt++) {
    pid_t pids[1024];
    int count = coalition_members(coalition_id, pids, sizeof(pids) / sizeof(pids[0]));
    if (count < 0) return false;
    if (count == 0) { bootout(target); return true; }
    for (int index = 0; index < count; index++) {
      if (pids[index] > 0 && pids[index] != getpid()) kill(pids[index], SIGKILL);
    }
    struct timespec delay = { .tv_sec = 0, .tv_nsec = 25 * 1000 * 1000 };
    nanosleep(&delay, NULL);
  }
  return false;
}

static int control_existing_job(const char *mode, const char *label) {
  if (!valid_label(label)) return 64;
  char *target = service_target(label);
  service_state state;
  if (target == NULL) {
    free(target);
    dprintf(STDOUT_FILENO, "unknown\n");
    return 4;
  }
  service_result state_result = read_state(target, &state);
  if (state_result == SERVICE_MISSING) {
    cleanup_output_pipes(label);
    free(target);
    dprintf(STDOUT_FILENO, "%s\n", strcmp(mode, "--probe") == 0 ? "absent" : "exited");
    return strcmp(mode, "--probe") == 0 ? 3 : 0;
  }
  if (state_result != SERVICE_OK || state.resource_coalition_id == 0) {
    free(target);
    dprintf(STDOUT_FILENO, "unknown\n");
    return 4;
  }
  pid_t pids[1024];
  int count = coalition_members(state.resource_coalition_id, pids, sizeof(pids) / sizeof(pids[0]));
  if (strcmp(mode, "--probe") == 0) {
    free(target);
    if (count < 0) { dprintf(STDOUT_FILENO, "unknown\n"); return 4; }
    // A newly submitted job can have an allocated coalition before its first
    // process starts. An empty coalition is an exit proof only after launchd
    // has recorded at least one run.
    if (count == 0 && state.runs < 1) { dprintf(STDOUT_FILENO, "unknown\n"); return 4; }
    if (count == 0) cleanup_output_pipes(label);
    dprintf(STDOUT_FILENO, "%s\n", count > 0 ? "alive" : "exited");
    return count > 0 ? 0 : 3;
  }
  if (strcmp(mode, "--terminate") == 0) {
    bool terminated = count == 0 ? (bootout(target), true) : terminate_coalition(target, state.resource_coalition_id);
    if (terminated) cleanup_output_pipes(label);
    free(target);
    return terminated ? 0 : 5;
  }
  free(target);
  return 64;
}

static int self_test(const char *label) {
  if (!valid_label(label)) return 64;
  char *target = service_target(label);
  if (target == NULL) return 70;
  char *arguments[] = { "launchctl", "submit", "-l", (char *)label, "--", "/bin/sleep", "5", NULL };
  if (run_launchctl(arguments, NULL, 0) != 0) { free(target); return 71; }
  int result = 72;
  for (int attempt = 0; attempt < 100; attempt++) {
    service_state state;
    if (read_state(target, &state) == SERVICE_OK && state.resource_coalition_id != 0) {
      pid_t pids[32];
      if (coalition_members(state.resource_coalition_id, pids, sizeof(pids) / sizeof(pids[0])) > 0) {
        result = terminate_coalition(target, state.resource_coalition_id) ? 0 : 73;
        break;
      }
    }
    struct timespec delay = { .tv_sec = 0, .tv_nsec = 20 * 1000 * 1000 };
    nanosleep(&delay, NULL);
  }
  bootout(target);
  free(target);
  if (result == 0) dprintf(STDOUT_FILENO, "supported\n");
  return result;
}

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "--self-test") == 0) return self_test(argv[2]);
  if (argc == 3 && (strcmp(argv[1], "--probe") == 0 || strcmp(argv[1], "--terminate") == 0)) {
    return control_existing_job(argv[1], argv[2]);
  }
  if (argc < 3 || !valid_label(argv[1])) {
    dprintf(STDERR_FILENO, "Usage: %s LABEL EXECUTABLE [ARG...]\n", argv[0]);
    return 64;
  }
  if (!launch_authorized()) return 75;

  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = request_stop;
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  signal(SIGPIPE, SIG_IGN);

  // launchd writes provider output into kernel-bounded FIFOs. The supervisor
  // relays them to its inherited pipes; if downstream stops reading, normal
  // pipe backpressure reaches the provider instead of growing files in /tmp
  // without limit. Paths are tied to the validated, unique ownership label so
  // restart recovery can safely reclaim them after a hard crash.
  char stdout_path[256];
  char stderr_path[256];
  int stdout_fd = create_output_pipe(stdout_path, sizeof(stdout_path), argv[1], "stdout");
  int stderr_fd = create_output_pipe(stderr_path, sizeof(stderr_path), argv[1], "stderr");
  if (stdout_fd < 0 || stderr_fd < 0) {
    if (stdout_fd >= 0) { close(stdout_fd); unlink(stdout_path); }
    if (stderr_fd >= 0) { close(stderr_fd); unlink(stderr_path); }
    return 70;
  }
  fcntl(stdout_fd, F_SETFL, O_NONBLOCK);
  fcntl(stderr_fd, F_SETFL, O_NONBLOCK);

  char current_directory[4096];
  if (getcwd(current_directory, sizeof(current_directory)) == NULL) {
    close(stdout_fd); close(stderr_fd); unlink(stdout_path); unlink(stderr_path);
    return 71;
  }

  // launchd assigns this provider a unique resource coalition. Kernel
  // coalition membership survives setsid() and reparenting, so it is the
  // durable ownership boundary. A positional shell wrapper is used only to
  // restore the launcher's working directory; provider arguments are never
  // interpolated into shell source.
  size_t argument_count = (size_t)argc + 13;
  char **submit = calloc(argument_count, sizeof(*submit));
  if (submit == NULL) {
    close(stdout_fd); close(stderr_fd); unlink(stdout_path); unlink(stderr_path);
    return 72;
  }
  size_t index = 0;
  submit[index++] = "launchctl";
  submit[index++] = "submit";
  submit[index++] = "-l";
  submit[index++] = argv[1];
  submit[index++] = "-o";
  submit[index++] = stdout_path;
  submit[index++] = "-e";
  submit[index++] = stderr_path;
  submit[index++] = "--";
  submit[index++] = "/bin/sh";
  submit[index++] = "-c";
  submit[index++] = "cd -- \"$1\" && shift && exec \"$@\"";
  submit[index++] = "outright-agent";
  submit[index++] = current_directory;
  for (int source = 2; source < argc; source++) submit[index++] = argv[source];
  submit[index] = NULL;

  char *target = service_target(argv[1]);
  if (target == NULL) {
    free(submit);
    close(stdout_fd); close(stderr_fd); unlink(stdout_path); unlink(stderr_path);
    return 73;
  }
  pid_t owner_pid = getppid();
  int submitted = run_launchctl(submit, NULL, 0);
  free(submit);
  if (submitted != 0) {
    close(stdout_fd); close(stderr_fd); unlink(stdout_path); unlink(stderr_path); free(target);
    return 73;
  }

  int result = 1;
  bool stopping = false;
  uint64_t coalition_id = 0;
  int provider_exit_code = 1;
  int state_failures = 0;
  for (;;) {
    relay(stdout_fd, STDOUT_FILENO);
    relay(stderr_fd, STDERR_FILENO);
    if ((stop_requested || getppid() != owner_pid) && !stopping) {
      stopping = true;
    }
    service_state state;
    service_result state_result = read_state(target, &state);
    if (state_result != SERVICE_OK) {
      state_failures++;
      if (coalition_id != 0 && terminate_coalition(target, coalition_id)) { result = stopping ? 137 : 70; break; }
      if (state_failures >= 50) {
        bootout(target);
        result = stopping ? 137 : 70;
        break;
      }
      struct timespec delay = { .tv_sec = 0, .tv_nsec = 100 * 1000 * 1000 };
      nanosleep(&delay, NULL);
      continue;
    }
    state_failures = 0;
    if (state.resource_coalition_id != 0) coalition_id = state.resource_coalition_id;
    if (state.runs >= 1 && state.active == 0) provider_exit_code = state.exit_code;
    if (stopping) {
      if (coalition_id != 0 && terminate_coalition(target, coalition_id)) { result = 137; break; }
      struct timespec delay = { .tv_sec = 0, .tv_nsec = 100 * 1000 * 1000 };
      nanosleep(&delay, NULL);
      continue;
    }
    pid_t pids[1024];
    int member_count = coalition_members(coalition_id, pids, sizeof(pids) / sizeof(pids[0]));
    if (member_count < 0) {
      bootout(target);
      result = 70;
      break;
    }
    if (state.runs >= 1 && state.active == 0 && member_count == 0) {
      result = provider_exit_code;
      bootout(target);
      break;
    }
    struct timespec delay = { .tv_sec = 0, .tv_nsec = 100 * 1000 * 1000 };
    nanosleep(&delay, NULL);
  }

  relay(stdout_fd, STDOUT_FILENO);
  relay(stderr_fd, STDERR_FILENO);
  close(stdout_fd);
  close(stderr_fd);
  unlink(stdout_path);
  unlink(stderr_path);
  free(target);
  return result;
}
