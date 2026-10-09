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

#define UTILITY_TREE_EMPTY "__OUTRIGHT_UTILITY_TREE_EMPTY_V1__\n"
#define MAX_LAUNCH_ENVIRONMENT (1024 * 1024)
extern char **environ;

static int utility_prelaunch_exit(int code) {
  if (getenv("OUTRIGHT_UTILITY_OWNER") != NULL) dprintf(3, "%s", UTILITY_TREE_EMPTY);
  return code;
}

// launchd control and recovery must use the same OS-owned private directory.
// Caller supplied TMPDIR is untrusted and can point at a public replacement.
static bool private_temporary_root(char *root, size_t capacity) {
  size_t needed = confstr(_CS_DARWIN_USER_TEMP_DIR, root, capacity);
  if (needed == 0 || needed > capacity) return false;
  char resolved[4096];
  if (realpath(root, resolved) == NULL || strlen(resolved) >= capacity) return false;
  struct stat info;
  if (stat(resolved, &info) != 0 || !S_ISDIR(info.st_mode)
      || info.st_uid != getuid() || (info.st_mode & 077) != 0) return false;
  strcpy(root, resolved);
  return true;
}

static bool coalition_marker_path(const char *label, char *filename, size_t capacity) {
  char root[4096];
  if (!private_temporary_root(root, sizeof(root))) return false;
  return snprintf(filename, capacity, "%s/outright-env-%s/coalition", root, label) < (int)capacity;
}

// -1: no invocation directory; 0: directory exists without trusted identity;
// 1: a full unsigned coalition identifier was read.
static int read_coalition_marker(const char *label, uint64_t *coalition_id);

static bool write_coalition_marker(const char *label, uint64_t coalition_id) {
  if (coalition_id == 0) return false;
  char filename[4096];
  if (!coalition_marker_path(label, filename, sizeof(filename))) return false;
  int descriptor = open(filename, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (descriptor < 0) {
    uint64_t existing = 0;
    return errno == EEXIST && read_coalition_marker(label, &existing) == 1 && existing == coalition_id;
  }
  char value[32];
  int length = snprintf(value, sizeof(value), "%llu\n", (unsigned long long)coalition_id);
  bool written = length > 0 && length < (int)sizeof(value)
    && write(descriptor, value, (size_t)length) == length && fsync(descriptor) == 0;
  if (close(descriptor) != 0) written = false;
  if (written) {
    char *slash = strrchr(filename, '/');
    if (slash == NULL) written = false;
    else {
      *slash = '\0';
      int directory_fd = open(filename, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      if (directory_fd < 0) written = false;
      else { if (fsync(directory_fd) != 0) written = false; close(directory_fd); }
      *slash = '/';
    }
  }
  if (!written) unlink(filename);
  return written;
}

static int read_coalition_marker(const char *label, uint64_t *coalition_id) {
  char filename[4096];
  if (!coalition_marker_path(label, filename, sizeof(filename))) return 0;
  int descriptor = open(filename, O_RDONLY | O_NOFOLLOW);
  if (descriptor < 0) {
    if (errno != ENOENT) return 0;
    char *slash = strrchr(filename, '/');
    if (slash == NULL) return 0;
    *slash = '\0';
    struct stat info;
    return lstat(filename, &info) == 0 ? 0 : (errno == ENOENT ? -1 : 0);
  }
  struct stat info;
  char value[32] = {0};
  ssize_t length = read(descriptor, value, sizeof(value) - 1);
  bool trusted = fstat(descriptor, &info) == 0 && S_ISREG(info.st_mode)
    && info.st_uid == getuid() && info.st_nlink == 1 && (info.st_mode & 077) == 0;
  close(descriptor);
  if (length <= 1 || !trusted) return 0;
  char *end = NULL;
  errno = 0;
  unsigned long long id = strtoull(value, &end, 10);
  if (errno != 0 || id == 0 || end != value + length - 1 || *end != '\n') return 0;
  *coalition_id = (uint64_t)id;
  return 1;
}

// launchctl submit starts a service with launchd's environment, not the
// caller's. Transfer the caller's bounded environment through a private file
// that the submitted helper unlinks before executing the command. Arguments
// and process listings never contain credential values.
static bool write_launch_environment(const char *label, char *directory, size_t directory_size,
  char *filename, size_t filename_size) {
  char resolved_root[4096];
  if (!private_temporary_root(resolved_root, sizeof(resolved_root))) return false;
  if (snprintf(directory, directory_size, "%s/outright-env-%s", resolved_root, label) >= (int)directory_size
      || mkdir(directory, 0700) != 0) return false;
  if (snprintf(filename, filename_size, "%s/environment", directory) >= (int)filename_size) {
    rmdir(directory);
    return false;
  }
  int descriptor = open(filename, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  bool complete = descriptor >= 0;
  size_t total = 0;
  for (char **entry = environ; complete && *entry != NULL; entry++) {
    if (strncmp(*entry, "OUTRIGHT_UTILITY_OWNER=", 23) == 0) continue;
    size_t length = strlen(*entry) + 1;
    if (length > MAX_LAUNCH_ENVIRONMENT - total) { complete = false; break; }
    total += length;
    const char *cursor = *entry;
    while (length > 0) {
      ssize_t written = write(descriptor, cursor, length);
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) { complete = false; break; }
      cursor += written;
      length -= (size_t)written;
    }
  }
  if (descriptor >= 0) {
    if (complete && fsync(descriptor) != 0) complete = false;
    if (close(descriptor) != 0) complete = false;
  }
  if (!complete) { unlink(filename); rmdir(directory); }
  return complete;
}

// Recovery removes only this invocation's private entry after launchd has
// been verified absent. Directory descriptors keep replacement of a pathname
// under the public temporary root from redirecting cleanup elsewhere.
static bool cleanup_launch_environment(const char *label) {
  char resolved_root[4096];
  if (!private_temporary_root(resolved_root, sizeof(resolved_root))) return false;
  int root_fd = open(resolved_root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (root_fd < 0) return false;
  char name[160];
  if (snprintf(name, sizeof(name), "outright-env-%s", label) >= (int)sizeof(name)) {
    close(root_fd);
    return false;
  }
  int directory_fd = openat(root_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (directory_fd < 0) {
    bool missing = errno == ENOENT;
    close(root_fd);
    return missing;
  }
  struct stat directory_info;
  bool safe = fstat(directory_fd, &directory_info) == 0 && S_ISDIR(directory_info.st_mode)
    && directory_info.st_uid == getuid() && (directory_info.st_mode & 077) == 0;
  if (safe) {
    int file_fd = openat(directory_fd, "environment", O_RDONLY | O_NOFOLLOW);
    if (file_fd >= 0) {
      struct stat file_info;
      safe = fstat(file_fd, &file_info) == 0 && S_ISREG(file_info.st_mode)
        && file_info.st_uid == getuid() && file_info.st_nlink == 1
        && (file_info.st_mode & 077) == 0;
      close(file_fd);
      if (safe && unlinkat(directory_fd, "environment", 0) != 0) safe = false;
    } else if (errno != ENOENT) safe = false;
  }
  if (safe) {
    int coalition_fd = openat(directory_fd, "coalition", O_RDONLY | O_NOFOLLOW);
    if (coalition_fd >= 0) {
      struct stat coalition_info;
      safe = fstat(coalition_fd, &coalition_info) == 0 && S_ISREG(coalition_info.st_mode)
        && coalition_info.st_uid == getuid() && coalition_info.st_nlink == 1;
      close(coalition_fd);
      if (safe && unlinkat(directory_fd, "coalition", 0) != 0) safe = false;
    } else if (errno != ENOENT) safe = false;
  }
  close(directory_fd);
  if (safe && unlinkat(root_fd, name, AT_REMOVEDIR) != 0 && errno != ENOENT) safe = false;
  close(root_fd);
  return safe;
}

static int exec_with_launch_environment(int argc, char **argv) {
  if (argc < 5) return 64;
  int descriptor = open(argv[2], O_RDONLY | O_NOFOLLOW);
  if (descriptor < 0) return 73;
  struct stat info;
  if (fstat(descriptor, &info) != 0 || !S_ISREG(info.st_mode)
      || info.st_uid != getuid() || (info.st_mode & 077) != 0
      || info.st_size < 0 || info.st_size > MAX_LAUNCH_ENVIRONMENT) {
    close(descriptor);
    return 73;
  }
  size_t length = (size_t)info.st_size;
  char *data = malloc(length + 1);
  if (data == NULL) { close(descriptor); return 72; }
  size_t used = 0;
  while (used < length) {
    ssize_t received = read(descriptor, data + used, length - used);
    if (received < 0 && errno == EINTR) continue;
    if (received <= 0) { close(descriptor); free(data); return 73; }
    used += (size_t)received;
  }
  close(descriptor);
  if (length > 0 && data[length - 1] != '\0') { free(data); return 73; }
  data[length] = '\0';
  char **environment = calloc(length + 1, sizeof(char *));
  if (environment == NULL) { free(data); return 72; }
  size_t count = 0;
  for (size_t offset = 0; offset < length;) {
    size_t entry_length = strnlen(data + offset, length - offset);
    if (entry_length == 0 || entry_length == length - offset
        || memchr(data + offset, '=', entry_length) == NULL) {
      free(environment); free(data); return 73;
    }
    environment[count++] = data + offset;
    offset += entry_length + 1;
  }
  // Keep the private directory until the owner proves the coalition empty.
  // Recovery needs the durable coalition marker after a supervisor crash.
  unlink(argv[2]);
  if (chdir(argv[3]) != 0) return 71;
  environ = environment;
  execvp(argv[4], &argv[4]);
  dprintf(STDERR_FILENO, "Unable to start owned command: %s\n", strerror(errno));
  return 127;
}

// Exported by libsystem_kernel on macOS. A launchd job receives a resource
// coalition, and every descendant remains a member even after setsid() or
// reparenting. This gives us a kernel-owned membership list without scanning
// the system process table.
typedef int (*coalition_pid_list_fn)(uint64_t coalition_id, void *buffer, size_t *buffer_size);

static volatile sig_atomic_t stop_requested = 0;
static void request_stop(int signal_number) { (void)signal_number; stop_requested = 1; }

static bool utility_start_authorized(pid_t owner_pid) {
  char command[3];
  size_t used = 0;
  while (used < sizeof(command) && !stop_requested) {
    ssize_t count = read(STDIN_FILENO, command + used, sizeof(command) - used);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return false;
    used += (size_t)count;
  }
  return !stop_requested && getppid() == owner_pid && memcmp(command, "go\n", sizeof(command)) == 0;
}

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
  if (getenv("CI") != NULL && getenv("OUTRIGHT_UTILITY_OWNER") != NULL)
    dprintf(3, "__OUTRIGHT_UTILITY_DIAGNOSTIC_V1__ bootout target=%s\n", target);
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

// An empty coalition is not a release proof while launchd still owns a
// submitted service: it may start the command again. Confirm that bootout
// removed the registration before reporting an empty utility tree.
static bool bootout_checked(const char *target) {
  for (int attempt = 0; attempt < 10; attempt++) {
    bootout(target);
    service_state state;
    if (read_state(target, &state) == SERVICE_MISSING) return true;
    struct timespec delay = { .tv_sec = 0, .tv_nsec = 50 * 1000 * 1000 };
    nanosleep(&delay, NULL);
  }
  return false;
}

static int coalition_members(uint64_t coalition_id, pid_t *pids, size_t capacity) {
  static coalition_pid_list_fn list_pids = NULL;
  static bool resolved = false;
  if (!resolved) {
    list_pids = (coalition_pid_list_fn)dlsym(RTLD_DEFAULT, "coalition_info_pid_list");
    resolved = true;
  }
  size_t size = capacity * sizeof(*pids);
  if (coalition_id == 0 || list_pids == NULL) { errno = ENOSYS; return -1; }
  errno = 0;
  if (list_pids(coalition_id, pids, &size) != 0) return -1;
  return (int)(size / sizeof(*pids));
}

// The kernel reaps a resource coalition only after its last member exits and
// never reuses its 64-bit identifier. Once launchd no longer owns the service,
// ESRCH for a durably recorded identifier proves that the tree is empty.
static int recorded_coalition_members(uint64_t coalition_id, pid_t *pids, size_t capacity) {
  int count = coalition_members(coalition_id, pids, capacity);
  return count < 0 && errno == ESRCH ? 0 : count;
}

// A missing service cannot be relaunched, but escaped members may remain in
// its recorded coalition. Kill them until the kernel reports it empty.
static bool kill_recorded_coalition(uint64_t coalition_id) {
  for (int attempt = 0; attempt < 100; attempt++) {
    pid_t pids[1024];
    int count = recorded_coalition_members(coalition_id, pids, sizeof(pids) / sizeof(pids[0]));
    if (count <= 0) return count == 0;
    for (int index = 0; index < count; index++) {
      if (pids[index] > 0 && pids[index] != getpid()) kill(pids[index], SIGKILL);
    }
    struct timespec delay = { .tv_sec = 0, .tv_nsec = 20 * 1000 * 1000 };
    nanosleep(&delay, NULL);
  }
  return false;
}

static bool terminate_coalition(const char *target, uint64_t coalition_id) {
  for (int attempt = 0; attempt < 100; attempt++) {
    pid_t pids[1024];
    int count = coalition_members(coalition_id, pids, sizeof(pids) / sizeof(pids[0]));
    if (count < 0) return false;
    if (count == 0) return bootout_checked(target);
    for (int index = 0; index < count; index++) {
      if (pids[index] > 0 && pids[index] != getpid()) {
        if (getenv("CI") != NULL && getenv("OUTRIGHT_UTILITY_OWNER") != NULL && attempt == 0 && index < 12)
          dprintf(3, "__OUTRIGHT_UTILITY_DIAGNOSTIC_V1__ coalition=%llu member=%ld signal=SIGKILL\n",
            (unsigned long long)coalition_id, (long)pids[index]);
        kill(pids[index], SIGKILL);
      }
    }
    struct timespec delay = { .tv_sec = 0, .tv_nsec = 25 * 1000 * 1000 };
    nanosleep(&delay, NULL);
  }
  return false;
}

// launchd no longer owns this label. Its durable coalition marker is the only
// membership proof; a missing invocation directory means none was recorded.
static int settle_missing_service(const char *mode, const char *label) {
  bool terminate = strcmp(mode, "--terminate") == 0;
  uint64_t coalition_id = 0;
  int marker = read_coalition_marker(label, &coalition_id);
  bool empty = marker < 0;
  if (marker > 0) {
    pid_t pids[1024];
    int count = recorded_coalition_members(coalition_id, pids, sizeof(pids) / sizeof(pids[0]));
    // Live members are reported as alive so recovery callers request the
    // teardown below instead of retaining an unresolvable unknown owner.
    if (count > 0 && !terminate) {
      dprintf(STDOUT_FILENO, "alive\n");
      return 0;
    }
    empty = count == 0 || (count > 0 && kill_recorded_coalition(coalition_id));
  }
  if (empty) cleanup_output_pipes(label);
  bool cleaned = empty && cleanup_launch_environment(label);
  dprintf(STDOUT_FILENO, "%s\n", cleaned ? (terminate ? "exited" : "absent") : "unknown");
  if (!cleaned) return 4;
  return terminate ? 0 : 3;
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
  // An unreadable or coalition-less service has no membership to inspect.
  // Terminate mode removes the registration, then settles it as missing.
  if ((state_result == SERVICE_ERROR || (state_result == SERVICE_OK && state.resource_coalition_id == 0))
      && strcmp(mode, "--terminate") == 0 && bootout_checked(target)) state_result = SERVICE_MISSING;
  if (state_result == SERVICE_MISSING) {
    free(target);
    return settle_missing_service(mode, label);
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
    bool terminated = count == 0 ? bootout_checked(target) : terminate_coalition(target, state.resource_coalition_id);
    if (terminated) {
      cleanup_output_pipes(label);
      terminated = cleanup_launch_environment(label);
    }
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
  if (argc > 1 && strcmp(argv[1], "--utility-exec") == 0)
    return exec_with_launch_environment(argc, argv);
  if (argc == 3 && strcmp(argv[1], "--self-test") == 0) return self_test(argv[2]);
  if (argc == 3 && (strcmp(argv[1], "--probe") == 0 || strcmp(argv[1], "--terminate") == 0)) {
    return control_existing_job(argv[1], argv[2]);
  }
  if (argc < 3 || !valid_label(argv[1])) {
    dprintf(STDERR_FILENO, "Usage: %s LABEL EXECUTABLE [ARG...]\n", argv[0]);
    return utility_prelaunch_exit(64);
  }
  if (!launch_authorized()) return utility_prelaunch_exit(75);
  if (getenv("OUTRIGHT_UTILITY_OWNER") != NULL) fcntl(3, F_SETFD, FD_CLOEXEC);
  bool terminal_control = getenv("OUTRIGHT_TERMINAL_CONTROL") != NULL;
  unsetenv("OUTRIGHT_TERMINAL_CONTROL");
  if (terminal_control) fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK);

  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = request_stop;
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  signal(SIGPIPE, SIG_IGN);
  pid_t owner_pid = getppid();
  if (getenv("OUTRIGHT_UTILITY_OWNER") != NULL && !utility_start_authorized(owner_pid))
    return utility_prelaunch_exit(0);

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
    return utility_prelaunch_exit(70);
  }
  fcntl(stdout_fd, F_SETFL, O_NONBLOCK);
  fcntl(stderr_fd, F_SETFL, O_NONBLOCK);

  char current_directory[4096];
  if (getcwd(current_directory, sizeof(current_directory)) == NULL) {
    close(stdout_fd); close(stderr_fd); unlink(stdout_path); unlink(stderr_path);
    return utility_prelaunch_exit(71);
  }

  // launchd assigns this provider a unique resource coalition. Kernel
  // coalition membership survives setsid() and reparenting, so it is the
  // durable ownership boundary. A native helper restores the launcher's
  // working directory and environment without putting
  // either environment values or provider arguments in shell source.
  char environment_directory[4096] = "";
  char environment_file[4096] = "";
  if (!write_launch_environment(argv[1], environment_directory, sizeof(environment_directory),
      environment_file, sizeof(environment_file))) {
    close(stdout_fd); close(stderr_fd); unlink(stdout_path); unlink(stderr_path);
    return utility_prelaunch_exit(72);
  }
  size_t argument_count = (size_t)argc + 13;
  char **submit = calloc(argument_count, sizeof(*submit));
  if (submit == NULL) {
    unlink(environment_file); rmdir(environment_directory);
    close(stdout_fd); close(stderr_fd); unlink(stdout_path); unlink(stderr_path);
    return utility_prelaunch_exit(72);
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
  submit[index++] = argv[0];
  submit[index++] = "--utility-exec";
  submit[index++] = environment_file;
  submit[index++] = current_directory;
  for (int source = 2; source < argc; source++) submit[index++] = argv[source];
  submit[index] = NULL;

  char *target = service_target(argv[1]);
  if (target == NULL) {
    unlink(environment_file); rmdir(environment_directory);
    free(submit);
    close(stdout_fd); close(stderr_fd); unlink(stdout_path); unlink(stderr_path);
    return utility_prelaunch_exit(73);
  }
  if (getenv("OUTRIGHT_UTILITY_OWNER") != NULL && (stop_requested || getppid() != owner_pid)) {
    unlink(environment_file); rmdir(environment_directory);
    close(stdout_fd); close(stderr_fd); unlink(stdout_path); unlink(stderr_path); free(target); free(submit);
    return utility_prelaunch_exit(0);
  }
  int submitted = run_launchctl(submit, NULL, 0);
  free(submit);
  if (submitted != 0) {
    unlink(environment_file); rmdir(environment_directory);
    close(stdout_fd); close(stderr_fd); unlink(stdout_path); unlink(stderr_path); free(target);
    return 73;
  }

  int result = 1;
  bool stopping = false;
  uint64_t coalition_id = 0;
  int provider_exit_code = 1;
  int state_failures = 0;
  bool tree_empty_proven = false;
  for (;;) {
    relay(stdout_fd, STDOUT_FILENO);
    relay(stderr_fd, STDERR_FILENO);
    if (terminal_control) {
      char command[16];
      ssize_t received = read(STDIN_FILENO, command, sizeof(command));
      if (received > 0 || received == 0) stop_requested = 1;
    }
    if ((stop_requested || getppid() != owner_pid) && !stopping) {
      stopping = true;
    }
    service_state state;
    service_result state_result = read_state(target, &state);
    if (state_result != SERVICE_OK) {
      state_failures++;
      if (coalition_id != 0 && terminate_coalition(target, coalition_id)) {
        tree_empty_proven = true;
        result = stopping ? 137 : 70;
        break;
      }
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
    if (state.resource_coalition_id != 0) {
      coalition_id = state.resource_coalition_id;
      if (!write_coalition_marker(argv[1], coalition_id)) {
        // Without durable identity a later owner crash cannot distinguish an
        // escaped descendant from an absent service. Stop this job now; keep
        // its capacity unknown if native teardown cannot prove emptiness.
        stopping = true;
        stop_requested = 1;
      }
    }
    if (state.runs >= 1 && state.active == 0) provider_exit_code = state.exit_code;
    if (stopping) {
      if (coalition_id != 0 && terminate_coalition(target, coalition_id)) {
        tree_empty_proven = true;
        result = 137;
        break;
      }
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
    if (getenv("OUTRIGHT_UTILITY_OWNER") != NULL
        && state.runs >= 1 && state.active == 0 && member_count > 0) {
      if (terminate_coalition(target, coalition_id)) {
        result = provider_exit_code;
        tree_empty_proven = true;
        break;
      }
      result = 70;
      break;
    }
    if (state.runs >= 1 && state.active == 0 && member_count == 0) {
      result = provider_exit_code;
      if (bootout_checked(target)) tree_empty_proven = true;
      else result = 70;
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
  // A failed coalition inspection or bootout has no empty-tree proof. Keep
  // its durable identity so a later missing-service probe cannot mistake an
  // escaped descendant for a never-submitted invocation.
  if (tree_empty_proven && !cleanup_launch_environment(argv[1])) {
    tree_empty_proven = false;
    result = 70;
  }
  if (tree_empty_proven && getenv("OUTRIGHT_UTILITY_OWNER") != NULL)
    dprintf(3, "%s", UTILITY_TREE_EMPTY);
  free(target);
  return result;
}
