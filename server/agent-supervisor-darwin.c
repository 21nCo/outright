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
#define LAUNCH_ENVIRONMENT "environment"
#define LAUNCH_DEFINITION "launch.plist"
#define LAUNCH_STATUS "status"
extern char **environ;

static int run_launchctl(char *const arguments[], char *output, size_t output_capacity);

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

static bool write_all(int descriptor, const char *cursor, size_t length) {
  while (length > 0) {
    ssize_t written = write(descriptor, cursor, length);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return false;
    cursor += written;
    length -= (size_t)written;
  }
  return true;
}

static bool write_launch_entry(int descriptor, const char *entry, size_t *total) {
  size_t length = strlen(entry) + 1;
  if (length > MAX_LAUNCH_ENVIRONMENT - *total) return false;
  *total += length;
  return write_all(descriptor, entry, length);
}

// A launchd job starts with launchd's environment, not the caller's. Transfer
// the caller's working directory, command and bounded environment through a
// private file that the launched helper claims exactly once. The job
// definition, arguments and process listings never contain credential values.
// Layout: NUL-terminated cwd, argument count, arguments, then environment.
static bool write_launch_environment(const char *label, const char *current_directory,
  int command_count, char **command, char *directory, size_t directory_size) {
  char resolved_root[4096];
  char filename[4096];
  if (!private_temporary_root(resolved_root, sizeof(resolved_root))) return false;
  if (snprintf(directory, directory_size, "%s/outright-env-%s", resolved_root, label) >= (int)directory_size
      || mkdir(directory, 0700) != 0) return false;
  if (snprintf(filename, sizeof(filename), "%s/" LAUNCH_ENVIRONMENT, directory) >= (int)sizeof(filename)) {
    rmdir(directory);
    return false;
  }
  int descriptor = open(filename, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  bool complete = descriptor >= 0;
  size_t total = 0;
  char count[16];
  snprintf(count, sizeof(count), "%d", command_count);
  if (complete) complete = write_launch_entry(descriptor, current_directory, &total)
    && write_launch_entry(descriptor, count, &total);
  for (int index = 0; complete && index < command_count; index++)
    complete = write_launch_entry(descriptor, command[index], &total);
  for (char **entry = environ; complete && *entry != NULL; entry++) {
    if (strncmp(*entry, "OUTRIGHT_UTILITY_OWNER=", 23) == 0) continue;
    complete = write_launch_entry(descriptor, *entry, &total);
  }
  if (descriptor >= 0) {
    if (complete && fsync(descriptor) != 0) complete = false;
    if (close(descriptor) != 0) complete = false;
  }
  if (!complete) { unlink(filename); rmdir(directory); }
  return complete;
}

static bool write_plist_string(FILE *file, const char *value) {
  fputs("<string>", file);
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor; cursor++) {
    // XML 1.0 cannot carry other C0 controls; refuse instead of altering a path.
    if (*cursor < 0x20 && *cursor != '\t' && *cursor != '\n' && *cursor != '\r') return false;
    if (*cursor == '&') fputs("&amp;", file);
    else if (*cursor == '<') fputs("&lt;", file);
    else if (*cursor == '>') fputs("&gt;", file);
    else fputc(*cursor, file);
  }
  fputs("</string>", file);
  return true;
}

// launchctl submit registers a KeepAlive job: launchd starts it again after
// every exit, so a finished provider would run twice and its first exit
// would be replaced by the relaunch's. A bootstrapped job definition with
// KeepAlive false runs once at load. launchd parses it during bootstrap, so
// the file is removed immediately afterwards.
static int bootstrap_job(const char *plist, const char *label, char *const arguments[],
  const char *stdout_path, const char *stderr_path) {
  int descriptor = open(plist, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (descriptor < 0) return -1;
  FILE *file = fdopen(descriptor, "w");
  if (file == NULL) { close(descriptor); unlink(plist); return -1; }
  fputs("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" "
    "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key>", file);
  bool valid = write_plist_string(file, label);
  fputs("\n<key>ProgramArguments</key><array>", file);
  for (char *const *argument = arguments; valid && *argument != NULL; argument++)
    valid = write_plist_string(file, *argument);
  fputs("</array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><false/>\n", file);
  if (valid && stdout_path != NULL) {
    fputs("<key>StandardOutPath</key>", file);
    valid = write_plist_string(file, stdout_path);
  }
  if (valid && stderr_path != NULL) {
    fputs("<key>StandardErrorPath</key>", file);
    valid = write_plist_string(file, stderr_path);
  }
  fputs("\n</dict></plist>\n", file);
  if (fflush(file) != 0 || fsync(descriptor) != 0) valid = false;
  if (fclose(file) != 0) valid = false;
  int status = -1;
  if (valid) {
    char domain[32];
    snprintf(domain, sizeof(domain), "gui/%u", getuid());
    char *bootstrap[] = { "launchctl", "bootstrap", domain, (char *)plist, NULL };
    status = run_launchctl(bootstrap, NULL, 0);
  }
  unlink(plist);
  return status;
}

// Removes one regular file this user created in the invocation directory.
// Absence is success; anything else there keeps the directory for review.
static bool remove_private_entry(int directory_fd, const char *name, bool private_mode) {
  int descriptor = openat(directory_fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (descriptor < 0) return errno == ENOENT;
  struct stat info;
  bool safe = fstat(descriptor, &info) == 0 && S_ISREG(info.st_mode)
    && info.st_uid == getuid() && info.st_nlink == 1
    && (!private_mode || (info.st_mode & 077) == 0);
  close(descriptor);
  return safe && unlinkat(directory_fd, name, 0) == 0;
}

// Recovery removes only this invocation's private entry after launchd has
// been verified absent. Directory descriptors keep replacement of a pathname
// under the public temporary root from redirecting cleanup elsewhere. The
// coalition marker goes last: it is the durable identity if cleanup stops.
static bool cleanup_launch_environment(const char *label) {
  char resolved_root[4096];
  if (!private_temporary_root(resolved_root, sizeof(resolved_root))) return false;
  int root_fd = open(resolved_root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root_fd < 0) return false;
  char name[160];
  if (snprintf(name, sizeof(name), "outright-env-%s", label) >= (int)sizeof(name)) {
    close(root_fd);
    return false;
  }
  int directory_fd = openat(root_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory_fd < 0) {
    bool missing = errno == ENOENT;
    close(root_fd);
    return missing;
  }
  struct stat directory_info;
  bool safe = fstat(directory_fd, &directory_info) == 0 && S_ISDIR(directory_info.st_mode)
    && directory_info.st_uid == getuid() && (directory_info.st_mode & 077) == 0
    && remove_private_entry(directory_fd, LAUNCH_ENVIRONMENT, true)
    && remove_private_entry(directory_fd, LAUNCH_DEFINITION, true)
    && remove_private_entry(directory_fd, LAUNCH_STATUS, true)
    && remove_private_entry(directory_fd, "coalition", false);
  close(directory_fd);
  if (safe && unlinkat(root_fd, name, AT_REMOVEDIR) != 0 && errno != ENOENT) safe = false;
  close(root_fd);
  return safe;
}

static bool record_first_exit(int directory_fd, int code) {
  int descriptor = openat(directory_fd, LAUNCH_STATUS, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (descriptor < 0) return false;
  char value[16];
  int length = snprintf(value, sizeof(value), "%d\n", code);
  bool written = write_all(descriptor, value, (size_t)length) && fsync(descriptor) == 0;
  if (close(descriptor) != 0) written = false;
  return written && fsync(directory_fd) == 0;
}

// 1: the helper recorded the provider's first exit; 0: no trusted record.
static int read_first_exit(const char *label, int *code) {
  char root[4096];
  char filename[4096];
  if (!private_temporary_root(root, sizeof(root))
      || snprintf(filename, sizeof(filename), "%s/outright-env-%s/" LAUNCH_STATUS, root, label) >= (int)sizeof(filename))
    return 0;
  int descriptor = open(filename, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (descriptor < 0) return 0;
  struct stat info;
  char value[16] = {0};
  ssize_t length = read(descriptor, value, sizeof(value) - 1);
  bool trusted = fstat(descriptor, &info) == 0 && S_ISREG(info.st_mode)
    && info.st_uid == getuid() && info.st_nlink == 1 && (info.st_mode & 077) == 0;
  close(descriptor);
  if (length <= 1 || !trusted) return 0;
  char *end = NULL;
  errno = 0;
  long recorded = strtol(value, &end, 10);
  if (errno != 0 || recorded < 0 || recorded > 255 || end != value + length - 1 || *end != '\n') return 0;
  *code = (int)recorded;
  return 1;
}

static volatile sig_atomic_t provider_pid = 0;
static void forward_signal(int signal_number) {
  if (provider_pid > 0) kill((pid_t)provider_pid, signal_number);
}

// Reads the private launch file and removes it. Only the invocation whose
// unlink succeeds may start the provider; every other start gets NULL.
static char *claim_launch_file(int directory_fd, size_t *length) {
  struct stat info;
  if (fstatat(directory_fd, LAUNCH_STATUS, &info, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) return NULL;
  int descriptor = openat(directory_fd, LAUNCH_ENVIRONMENT, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (descriptor < 0) return NULL;
  char *data = NULL;
  if (fstat(descriptor, &info) == 0 && S_ISREG(info.st_mode) && info.st_uid == getuid()
      && info.st_nlink == 1 && (info.st_mode & 077) == 0
      && info.st_size > 0 && info.st_size <= MAX_LAUNCH_ENVIRONMENT) data = malloc((size_t)info.st_size + 1);
  size_t used = 0;
  while (data != NULL && used < (size_t)info.st_size) {
    ssize_t received = read(descriptor, data + used, (size_t)info.st_size - used);
    if (received < 0 && errno == EINTR) continue;
    if (received <= 0) break;
    used += (size_t)received;
  }
  close(descriptor);
  if (data == NULL || used != (size_t)info.st_size || unlinkat(directory_fd, LAUNCH_ENVIRONMENT, 0) != 0) {
    free(data);
    return NULL;
  }
  data[used] = '\0';
  *length = used;
  return data;
}

// Splits the claimed file into cwd, command and environment. The returned
// array owns the command pointers; environment points into the token list.
static char **parse_launch_file(char *data, size_t length, char ***tokens, char ***environment) {
  size_t token_count = 0;
  for (size_t offset = 0; offset < length; offset++) if (data[offset] == '\0') token_count++;
  if (token_count < 3 || data[length - 1] != '\0') return NULL;
  *tokens = calloc(token_count + 1, sizeof(char *));
  if (*tokens == NULL) return NULL;
  for (size_t offset = 0, index = 0; offset < length; index++) {
    (*tokens)[index] = data + offset;
    offset += strlen(data + offset) + 1;
  }
  char *end = NULL;
  long command_count = strtol((*tokens)[1], &end, 10);
  if ((*tokens)[0][0] == '\0' || end == (*tokens)[1] || *end != '\0' || command_count < 1
      || (size_t)command_count > token_count - 2 || (*tokens)[2][0] == '\0') return NULL;
  *environment = *tokens + 2 + command_count;
  for (char **entry = *environment; *entry != NULL; entry++)
    if ((*entry)[0] == '\0' || strchr(*entry, '=') == NULL) return NULL;
  char **command = calloc((size_t)command_count + 1, sizeof(char *));
  if (command != NULL) memcpy(command, *tokens + 2, (size_t)command_count * sizeof(char *));
  return command;
}

// Runs the provider as a child so its exit can be recorded. Termination
// requests sent to the job's main process are forwarded to the provider.
static int run_provider(char **command, char **environment) {
  sigset_t forwarded;
  sigset_t previous;
  sigemptyset(&forwarded);
  sigaddset(&forwarded, SIGTERM);
  sigaddset(&forwarded, SIGINT);
  sigaddset(&forwarded, SIGHUP);
  sigprocmask(SIG_BLOCK, &forwarded, &previous);
  pid_t child = fork();
  if (child == 0) {
    sigprocmask(SIG_SETMASK, &previous, NULL);
    environ = environment;
    execvp(command[0], command);
    dprintf(STDERR_FILENO, "Unable to start owned command: %s\n", strerror(errno));
    _exit(127);
  }
  if (child < 0) {
    sigprocmask(SIG_SETMASK, &previous, NULL);
    return 72;
  }
  provider_pid = child;
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = forward_signal;
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGHUP, &action, NULL);
  sigprocmask(SIG_SETMASK, &previous, NULL);
  int status = 0;
  pid_t waited;
  while ((waited = waitpid(child, &status, 0)) < 0 && errno == EINTR) {}
  if (waited != child) return 70;
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 70;
}

// The launchd job's main process. It claims the launch file exactly once,
// runs the provider and durably records the provider's exit before exiting
// with it. Any later start of the same job (kickstart or a relaunch) finds
// the claim taken and runs nothing, so the recorded first exit stays the
// job's only provider status.
static int run_launch_command(int argc, char **argv) {
  if (argc != 3) return 64;
  int directory_fd = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory_fd < 0) return 73;
  struct stat info;
  size_t length = 0;
  char *data = fstat(directory_fd, &info) == 0 && S_ISDIR(info.st_mode)
    && info.st_uid == getuid() && (info.st_mode & 077) == 0 ? claim_launch_file(directory_fd, &length) : NULL;
  if (data == NULL) {
    close(directory_fd);
    return 73;
  }
  char **tokens = NULL;
  char **environment = NULL;
  char **command = parse_launch_file(data, length, &tokens, &environment);
  int code = 73;
  if (command != NULL) code = chdir(tokens[0]) == 0 ? run_provider(command, environment) : 71;
  record_first_exit(directory_fd, code);
  close(directory_fd);
  free(command); free(tokens); free(data);
  return code;
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
// registered service: a kickstart may start the command again. Confirm that bootout
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
    // A newly registered job can have an allocated coalition before its first
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
  // Verify the registration production uses: a run-once bootstrapped job.
  char directory[4096];
  char definition[4096];
  if (!private_temporary_root(directory, sizeof(directory))
      || strlcat(directory, "/outright-self-test-XXXXXX", sizeof(directory)) >= sizeof(directory)
      || mkdtemp(directory) == NULL) { free(target); return 71; }
  snprintf(definition, sizeof(definition), "%s/" LAUNCH_DEFINITION, directory);
  char *arguments[] = { "/bin/sleep", "5", NULL };
  int registered = bootstrap_job(definition, label, arguments, NULL, NULL);
  rmdir(directory);
  if (registered != 0) { free(target); return 71; }
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
    return run_launch_command(argc, argv);
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
  // working directory and environment without putting either environment
  // values or provider arguments in shell source or the job definition.
  char environment_directory[4096] = "";
  char definition[4096] = "";
  if (!write_launch_environment(argv[1], current_directory, argc - 2, argv + 2,
      environment_directory, sizeof(environment_directory))) {
    close(stdout_fd); close(stderr_fd); unlink(stdout_path); unlink(stderr_path);
    return utility_prelaunch_exit(72);
  }
  char *target = service_target(argv[1]);
  if (target == NULL || snprintf(definition, sizeof(definition), "%s/" LAUNCH_DEFINITION,
      environment_directory) >= (int)sizeof(definition)) {
    cleanup_launch_environment(argv[1]);
    free(target);
    close(stdout_fd); close(stderr_fd); unlink(stdout_path); unlink(stderr_path);
    return utility_prelaunch_exit(73);
  }
  if (getenv("OUTRIGHT_UTILITY_OWNER") != NULL && (stop_requested || getppid() != owner_pid)) {
    cleanup_launch_environment(argv[1]);
    close(stdout_fd); close(stderr_fd); unlink(stdout_path); unlink(stderr_path); free(target);
    return utility_prelaunch_exit(0);
  }
  char *job[] = { argv[0], "--utility-exec", environment_directory, NULL };
  int submitted = bootstrap_job(definition, argv[1], job, stdout_path, stderr_path);
  if (submitted != 0) {
    cleanup_launch_environment(argv[1]);
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
    // The helper's record is the provider's first exit. launchd's last exit
    // code describes the provider only when the job has run exactly once and
    // the helper stopped before it could record a status.
    if (state.runs >= 1 && state.active == 0 && read_first_exit(argv[1], &provider_exit_code) != 1)
      provider_exit_code = state.runs == 1 ? state.exit_code : 70;
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
  // escaped descendant for a never-registered invocation.
  if (tree_empty_proven && !cleanup_launch_environment(argv[1])) {
    tree_empty_proven = false;
    result = 70;
  }
  if (tree_empty_proven && getenv("OUTRIGHT_UTILITY_OWNER") != NULL)
    dprintf(3, "%s", UTILITY_TREE_EMPTY);
  free(target);
  return result;
}
