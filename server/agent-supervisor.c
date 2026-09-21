#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200809L

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define INPUT_CAPACITY 4096
#define TEARDOWN_BUDGET_MS 750

static volatile sig_atomic_t termination_requested = 0;

static void on_termination_signal(int signal_number) {
  (void)signal_number;
  termination_requested = 1;
}

static long long monotonic_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
  return (long long)now.tv_sec * 1000LL + now.tv_nsec / 1000000LL;
}

static void sleep_ms(int milliseconds) {
  struct timespec delay = { .tv_sec = milliseconds / 1000, .tv_nsec = (milliseconds % 1000) * 1000000L };
  while (nanosleep(&delay, &delay) != 0 && errno == EINTR) {}
}

static int ensure_parent_directory(const char *filename) {
  char *copy = strdup(filename);
  if (copy == NULL) return -1;
  for (char *cursor = copy + 1; *cursor != '\0'; cursor++) {
    if (*cursor != '/') continue;
    *cursor = '\0';
    if (mkdir(copy, 0700) != 0 && errno != EEXIST) {
      free(copy);
      return -1;
    }
    *cursor = '/';
  }
  free(copy);
  return 0;
}

static int write_handshake(const char *path, bool authorized, pid_t provider_pid) {
  if (ensure_parent_directory(path) != 0) return -1;
  size_t temporary_size = strlen(path) + 64;
  char *temporary = malloc(temporary_size);
  if (temporary == NULL) return -1;
  snprintf(temporary, temporary_size, "%s.tmp.%ld", path, (long)getpid());
  int descriptor = open(temporary, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (descriptor < 0) {
    free(temporary);
    return -1;
  }
  time_t wall_time = time(NULL);
  struct tm utc;
  char created_at[32] = "";
  if (gmtime_r(&wall_time, &utc) != NULL) strftime(created_at, sizeof(created_at), "%Y-%m-%dT%H:%M:%SZ", &utc);
  int written = authorized
    ? dprintf(descriptor, "{\"pid\":%ld,\"authorized\":true,\"providerPid\":%ld,\"createdAt\":\"%s\"}", (long)getpid(), (long)provider_pid, created_at)
    : dprintf(descriptor, "{\"pid\":%ld,\"authorized\":false,\"createdAt\":\"%s\"}", (long)getpid(), created_at);
  int result = 0;
  if (written < 0 || fsync(descriptor) != 0) result = -1;
  if (close(descriptor) != 0) result = -1;
  if (result == 0 && rename(temporary, path) != 0) result = -1;
  if (result == 0) {
    char *parent = strdup(path);
    if (parent == NULL) result = -1;
    else {
      char *slash = strrchr(parent, '/');
      if (slash == NULL) strcpy(parent, ".");
      else if (slash == parent) slash[1] = '\0';
      else *slash = '\0';
      int directory = open(parent, O_RDONLY | O_DIRECTORY);
      if (directory < 0 || fsync(directory) != 0) result = -1;
      if (directory >= 0 && close(directory) != 0) result = -1;
      free(parent);
    }
  }
  if (result != 0) unlink(temporary);
  free(temporary);
  return result;
}

typedef enum {
  PROCESS_STAT_FOUND,
  PROCESS_STAT_GONE,
  PROCESS_STAT_UNKNOWN,
} process_stat_result;

static process_stat_result read_process_stat(pid_t pid, char *state, pid_t *parent, pid_t *group) {
  char filename[64];
  snprintf(filename, sizeof(filename), "/proc/%ld/stat", (long)pid);
  FILE *file = fopen(filename, "r");
  if (file == NULL) return errno == ENOENT || errno == ESRCH ? PROCESS_STAT_GONE : PROCESS_STAT_UNKNOWN;
  char line[4096];
  process_stat_result result = PROCESS_STAT_UNKNOWN;
  if (fgets(line, sizeof(line), file) != NULL) {
    char *close = strrchr(line, ')');
    long parsed_parent = 0;
    long parsed_group = 0;
    char parsed_state = '\0';
    if (close != NULL && sscanf(close + 2, "%c %ld %ld", &parsed_state, &parsed_parent, &parsed_group) == 3) {
      *state = parsed_state;
      *parent = (pid_t)parsed_parent;
      *group = (pid_t)parsed_group;
      result = PROCESS_STAT_FOUND;
    }
  }
  fclose(file);
  return result;
}

typedef struct {
  int count;
  int live_count;
  bool complete;
} process_snapshot;

typedef enum {
  NOT_OWNED,
  OWNED,
  OWNERSHIP_UNKNOWN,
} ownership_result;

static ownership_result is_owned_descendant(pid_t pid, pid_t supervisor_pid) {
  pid_t cursor = pid;
  for (int depth = 0; depth < 256; depth++) {
    char state;
    pid_t parent;
    pid_t group;
    process_stat_result result = read_process_stat(cursor, &state, &parent, &group);
    if (result == PROCESS_STAT_GONE) return cursor == pid ? NOT_OWNED : OWNERSHIP_UNKNOWN;
    if (result == PROCESS_STAT_UNKNOWN) return OWNERSHIP_UNKNOWN;
    (void)state;
    (void)group;
    if (parent == supervisor_pid) return OWNED;
    if (parent <= 1 || parent == cursor) return NOT_OWNED;
    cursor = parent;
  }
  return OWNERSHIP_UNKNOWN;
}

static process_snapshot inspect_owned_tree(pid_t supervisor_pid, pid_t provider_pid, bool kill_live_members) {
  process_snapshot snapshot = { 0, 0, true };
  DIR *directory = opendir("/proc");
  if (directory == NULL) {
    snapshot.complete = false;
    return snapshot;
  }
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    char *end = NULL;
    long value = strtol(entry->d_name, &end, 10);
    if (entry->d_name[0] == '\0' || end == NULL || *end != '\0' || value <= 0) continue;
    pid_t pid = (pid_t)value;
    if (pid == getpid()) continue;
    char state;
    pid_t parent;
    pid_t group;
    process_stat_result stat_result = read_process_stat(pid, &state, &parent, &group);
    if (stat_result == PROCESS_STAT_GONE) continue;
    if (stat_result == PROCESS_STAT_UNKNOWN) {
      snapshot.complete = false;
      continue;
    }
    ownership_result ownership = is_owned_descendant(pid, supervisor_pid);
    if (ownership == OWNERSHIP_UNKNOWN) {
      snapshot.complete = false;
      continue;
    }
    if (ownership != OWNED) continue;
    (void)parent;
    (void)group;
    snapshot.count++;
    if (state != 'Z') snapshot.live_count++;
    if (kill_live_members && state != 'Z' && pid != provider_pid) kill(pid, SIGKILL);
  }
  closedir(directory);
  return snapshot;
}

static void reap_children(pid_t provider_pid, bool *provider_reaped, int *provider_status) {
  for (;;) {
    int status = 0;
    pid_t reaped = waitpid(-1, &status, WNOHANG);
    if (reaped <= 0) return;
    if (reaped == provider_pid) {
      *provider_reaped = true;
      *provider_status = status;
    }
  }
}

static void exit_like_provider(int status) {
  if (WIFEXITED(status)) _exit(WEXITSTATUS(status));
  if (WIFSIGNALED(status)) {
    int signal_number = WTERMSIG(status);
    signal(signal_number, SIG_DFL);
    kill(getpid(), signal_number);
    _exit(128 + signal_number);
  }
  _exit(1);
}

static int authorize_provider(char **provider_argv, const char *handshake_path, pid_t *provider_pid) {
  int authorization_pipe[2];
  if (pipe(authorization_pipe) != 0) return -1;
  fcntl(authorization_pipe[0], F_SETFD, FD_CLOEXEC);
  fcntl(authorization_pipe[1], F_SETFD, FD_CLOEXEC);
  pid_t child = fork();
  if (child < 0) {
    close(authorization_pipe[0]);
    close(authorization_pipe[1]);
    return -1;
  }
  if (child == 0) {
    close(authorization_pipe[1]);
    signal(SIGTERM, SIG_DFL);
    signal(SIGINT, SIG_DFL);
    char authorization = '\0';
    ssize_t received;
    do { received = read(authorization_pipe[0], &authorization, 1); } while (received < 0 && errno == EINTR);
    close(authorization_pipe[0]);
    if (received != 1 || authorization != '1') _exit(126);
    int null_input = open("/dev/null", O_RDONLY);
    if (null_input < 0 || dup2(null_input, STDIN_FILENO) < 0) _exit(126);
    if (null_input != STDIN_FILENO) close(null_input);
    execvp(provider_argv[0], provider_argv);
    dprintf(STDERR_FILENO, "Unable to start provider: %s\n", strerror(errno));
    _exit(127);
  }
  close(authorization_pipe[0]);
  *provider_pid = child;
  if (write_handshake(handshake_path, true, child) != 0) {
    close(authorization_pipe[1]);
    kill(child, SIGKILL);
    while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {}
    return -1;
  }
  char authorization = '1';
  ssize_t sent;
  do { sent = write(authorization_pipe[1], &authorization, 1); } while (sent < 0 && errno == EINTR);
  close(authorization_pipe[1]);
  if (sent == 1) return 0;
  kill(child, SIGKILL);
  while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {}
  return -1;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    dprintf(STDERR_FILENO, "Usage: %s HANDSHAKE_PATH EXECUTABLE [ARG...]\n", argv[0]);
    return 64;
  }
  const char *handshake_path = argv[1];
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) != 0) {
    dprintf(STDERR_FILENO, "Unable to claim provider descendants: %s\n", strerror(errno));
    return 70;
  }
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = on_termination_signal;
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  if (write_handshake(handshake_path, false, 0) != 0) {
    dprintf(STDERR_FILENO, "Unable to persist launch ownership: %s\n", strerror(errno));
    return 73;
  }

  bool authorized = false;
  bool stopping = false;
  bool stop_requested = false;
  bool provider_reaped = false;
  bool provider_kill_sent = false;
  bool input_closed = false;
  pid_t provider_pid = 0;
  int provider_status = 0;
  long long teardown_deadline = 0;
  char input[INPUT_CAPACITY];
  size_t input_length = 0;

  for (;;) {
    reap_children(provider_pid, &provider_reaped, &provider_status);
    if (authorized && termination_requested && !stopping) {
      stopping = true;
      stop_requested = true;
      teardown_deadline = monotonic_ms() + TEARDOWN_BUDGET_MS;
    }
    if (authorized && provider_reaped && !stopping) {
      stopping = true;
      provider_kill_sent = true;
      teardown_deadline = monotonic_ms() + TEARDOWN_BUDGET_MS;
    }
    if (stopping) {
      process_snapshot snapshot = inspect_owned_tree(getpid(), provider_pid, true);
      if (!provider_kill_sent && ((snapshot.complete && snapshot.live_count <= 1) || monotonic_ms() >= teardown_deadline)) {
        if (!provider_reaped) kill(provider_pid, SIGKILL);
        provider_kill_sent = true;
      }
      reap_children(provider_pid, &provider_reaped, &provider_status);
      snapshot = inspect_owned_tree(getpid(), provider_pid, true);
      if (provider_reaped && snapshot.complete && snapshot.count == 0) {
        unlink(handshake_path);
        if (stop_requested || termination_requested) _exit(137);
        exit_like_provider(provider_status);
      }
    }

    if (!authorized && (termination_requested || input_closed)) {
      unlink(handshake_path);
      return 0;
    }

    if (input_closed) {
      sleep_ms(25);
      continue;
    }

    struct pollfd descriptor = { .fd = STDIN_FILENO, .events = POLLIN | POLLHUP };
    int poll_result = poll(&descriptor, 1, 25);
    if (poll_result < 0 && errno != EINTR) {
      if (!authorized) unlink(handshake_path);
      return 74;
    }
    if (poll_result <= 0) continue;
    if (descriptor.revents & POLLIN) {
      ssize_t read_count = read(STDIN_FILENO, input + input_length, sizeof(input) - input_length - 1);
      if (read_count > 0) {
        input_length += (size_t)read_count;
        input[input_length] = '\0';
        char *line_start = input;
        char *newline;
        while ((newline = strchr(line_start, '\n')) != NULL) {
          *newline = '\0';
          size_t line_length = strlen(line_start);
          while (line_length > 0 && (line_start[line_length - 1] == '\r' || line_start[line_length - 1] == ' ' || line_start[line_length - 1] == '\t')) line_start[--line_length] = '\0';
          while (*line_start == ' ' || *line_start == '\t') line_start++;
          if (strcmp(line_start, "go") == 0 && !authorized) {
            if (authorize_provider(&argv[2], handshake_path, &provider_pid) != 0) {
              unlink(handshake_path);
              return 75;
            }
            authorized = true;
          } else if (strcmp(line_start, "stop") == 0) {
            if (!authorized) {
              unlink(handshake_path);
              return 0;
            }
            if (!stopping) {
              stopping = true;
              stop_requested = true;
              teardown_deadline = monotonic_ms() + TEARDOWN_BUDGET_MS;
            }
          }
          line_start = newline + 1;
        }
        size_t remaining = input + input_length - line_start;
        memmove(input, line_start, remaining);
        input_length = remaining;
        if (input_length == sizeof(input) - 1) {
          if (!authorized) unlink(handshake_path);
          return 65;
        }
      } else if (read_count == 0) {
        input_closed = true;
      }
    }
    if (descriptor.revents & POLLHUP) input_closed = true;
    sleep_ms(1);
  }
}
