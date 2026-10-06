#define _WIN32_WINNT 0x0602
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <io.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define UTILITY_TREE_EMPTY "__OUTRIGHT_UTILITY_TREE_EMPTY_V1__\n"

// Windows volumes may report ino=0 to Node. Compare native file IDs before
// treating two pathnames as a hard-link pair or skipping a second byte lock.
// Unknown identity is never evidence that two paths are the same file.
static int compare_file_handles(HANDLE left, HANDLE right) {
  FILE_ID_INFO first = {0}, second = {0};
  if (GetFileInformationByHandleEx(left, FileIdInfo, &first, sizeof(first))
    && GetFileInformationByHandleEx(right, FileIdInfo, &second, sizeof(second))) {
    unsigned char zero[sizeof(first.FileId.Identifier)] = {0};
    if (memcmp(first.FileId.Identifier, zero, sizeof(zero)) != 0
      && memcmp(second.FileId.Identifier, zero, sizeof(zero)) != 0) {
      return first.VolumeSerialNumber == second.VolumeSerialNumber
        && memcmp(first.FileId.Identifier, second.FileId.Identifier, sizeof(zero)) == 0;
    }
  }
  BY_HANDLE_FILE_INFORMATION a = {0}, b = {0};
  if (!GetFileInformationByHandle(left, &a) || !GetFileInformationByHandle(right, &b)
    || (!a.nFileIndexHigh && !a.nFileIndexLow)
    || (!b.nFileIndexHigh && !b.nFileIndexLow)) return -1;
  return a.dwVolumeSerialNumber == b.dwVolumeSerialNumber
    && a.nFileIndexHigh == b.nFileIndexHigh && a.nFileIndexLow == b.nFileIndexLow;
}

static int same_file(int argc, wchar_t **argv) {
  if (argc != 4) return 64;
  HANDLE left = CreateFileW(argv[2], FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (left == INVALID_HANDLE_VALUE) return 4;
  HANDLE right = CreateFileW(argv[3], FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (right == INVALID_HANDLE_VALUE) { CloseHandle(left); return 4; }
  int comparison = compare_file_handles(left, right);
  CloseHandle(right);
  CloseHandle(left);
  return comparison == 1 ? 0 : comparison == 0 ? 3 : 4;
}

// Hold SQLite's Windows lock-byte range with a handle that permits rename.
// SQLite's own handles omit FILE_SHARE_DELETE, so they cannot be retained
// across archive promotion. The parent rechecks both files after this helper
// acquires the lock and before any rename.
static int archive_lock(int argc, wchar_t **argv) {
  if (argc < 6) return 64;
  wchar_t *end = NULL;
  unsigned long parent_pid = wcstoul(argv[2], &end, 10);
  if (!parent_pid || end == argv[2] || *end != L'\0') return 64;
  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, parent_pid);
  if (!parent) return 70;
  HANDLE *files = calloc((size_t)(argc - 5), sizeof(HANDLE));
  if (!files) { CloseHandle(parent); return 72; }
  int held = 0;
  int result = 0;
  for (int index = 5; index < argc; index++) {
    HANDLE file = CreateFileW(argv[index], GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) { result = 73; break; }
    bool duplicate = false;
    for (int previous = 0; previous < held; previous++) {
      if (compare_file_handles(files[previous], file) == 1) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) { CloseHandle(file); continue; }
    OVERLAPPED overlap = {0};
    overlap.Offset = 0x40000000;
    if (!LockFileEx(file, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
        0, 512, 0, &overlap)) { CloseHandle(file); result = 74; break; }
    files[held++] = file;
  }
  HANDLE ready = CreateFileW(argv[3], GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_DELETE, NULL, CREATE_NEW,
    FILE_ATTRIBUTE_NORMAL, NULL);
  if (ready == INVALID_HANDLE_VALUE) result = result ? result : 75;
  else {
    char status[16];
    int length = snprintf(status, sizeof(status), "%d", result);
    DWORD written = 0;
    if (!WriteFile(ready, status, (DWORD)length, &written, NULL)
      || written != (DWORD)length || !FlushFileBuffers(ready)) result = 76;
    CloseHandle(ready);
  }
  // The pipe's only writer belongs to the archive worker thread. A worker
  // termination closes it even if the runtime process remains alive. The
  // private stop marker handles normal synchronous release; the process
  // handle covers a hard runtime exit.
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  while (WaitForSingleObject(parent, 10) == WAIT_TIMEOUT) {
    if (GetFileAttributesW(argv[4]) != INVALID_FILE_ATTRIBUTES) break;
    if (input == NULL || input == INVALID_HANDLE_VALUE
      || !PeekNamedPipe(input, NULL, 0, NULL, NULL, NULL)) break;
  }
  for (int index = held - 1; index >= 0; index--) CloseHandle(files[index]);
  free(files);
  CloseHandle(parent);
  DeleteFileW(argv[3]);
  // The stop marker belongs to this same lock lifetime. Removing it after
  // the ready marker keeps an interrupted JS worker from leaking artifacts.
  DeleteFileW(argv[4]);
  return result;
}

static wchar_t *quote_argument(const wchar_t *value) {
  size_t length = wcslen(value);
  wchar_t *quoted = calloc(length * 2 + 3, sizeof(wchar_t));
  if (!quoted) return NULL;
  wchar_t *out = quoted;
  *out++ = L'"';
  size_t slashes = 0;
  for (const wchar_t *cursor = value; ; cursor++) {
    wchar_t character = *cursor;
    if (character == L'\\') { slashes++; continue; }
    if (character == L'"' || character == L'\0') {
      for (size_t index = 0; index < slashes * 2; index++) *out++ = L'\\';
      if (character == L'"') {
        // CommandLineToArgvW/CRT parsing requires 2n+1 backslashes before an
        // embedded quote. The extra slash preserves the quote as data.
        *out++ = L'\\';
        *out++ = L'"';
      }
      slashes = 0;
      if (character == L'\0') break;
      continue;
    }
    for (size_t index = 0; index < slashes; index++) *out++ = L'\\';
    slashes = 0;
    *out++ = character;
  }
  *out++ = L'"';
  *out = L'\0';
  return quoted;
}

static wchar_t *command_line(int argc, wchar_t **argv, int first_argument) {
  size_t capacity = 1;
  wchar_t **parts = calloc((size_t)argc, sizeof(*parts));
  if (!parts) return NULL;
  for (int index = first_argument; index < argc; index++) {
    parts[index] = quote_argument(argv[index]);
    if (!parts[index]) return NULL;
    capacity += wcslen(parts[index]) + 1;
  }
  wchar_t *line = calloc(capacity, sizeof(*line));
  if (!line) return NULL;
  for (int index = first_argument; index < argc; index++) {
    if (index > first_argument) wcscat_s(line, capacity, L" ");
    wcscat_s(line, capacity, parts[index]);
    free(parts[index]);
  }
  free(parts);
  return line;
}

// The runtime owns the only writer of this control pipe. Closing it on a hard
// runtime exit tears down the Job Object; an explicit stop uses the same path.
// The supervisor remains alive until the kernel reports zero job members.
static DWORD WINAPI watch_owner(void *raw_job) {
  HANDLE job = (HANDLE)raw_job;
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (input == NULL || input == INVALID_HANDLE_VALUE) {
    TerminateJobObject(job, 137);
    return 0;
  }
  char buffer[32];
  DWORD count = 0;
  // Only the runtime holds the write end. Any command means stop; this also
  // handles a control message split across pipe reads.
  ReadFile(input, buffer, sizeof(buffer), &count, NULL);
  TerminateJobObject(job, 137);
  return 0;
}

static unsigned long long process_birth(HANDLE process) {
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) return 0;
  return ((unsigned long long)created.dwHighDateTime << 32) | created.dwLowDateTime;
}

static int inspect_owner(int argc, wchar_t **argv) {
  bool identity = wcscmp(argv[1], L"--identity") == 0;
  bool terminate = wcscmp(argv[1], L"--terminate") == 0;
  if ((identity && argc != 3) || (!identity && argc != 4)) return 64;
  wchar_t *end = NULL;
  unsigned long pid = wcstoul(argv[2], &end, 10);
  if (pid == 0 || end == argv[2] || *end != L'\0') return 64;
  unsigned long long expected = 0;
  if (!identity) {
    end = NULL;
    expected = _wcstoui64(argv[3], &end, 10);
    if (expected == 0 || end == argv[3] || *end != L'\0') return 64;
  }
  DWORD access = PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;
  if (terminate) access |= PROCESS_TERMINATE;
  HANDLE process = OpenProcess(access, FALSE, (DWORD)pid);
  if (!process) {
    if (GetLastError() == ERROR_INVALID_PARAMETER) { wprintf(L"absent\n"); return 3; }
    wprintf(L"unknown\n"); return 4;
  }
  unsigned long long birth = process_birth(process);
  if (birth == 0) { CloseHandle(process); wprintf(L"unknown\n"); return 4; }
  if (identity) { wprintf(L"%llu\n", birth); CloseHandle(process); return 0; }
  if (birth != expected || WaitForSingleObject(process, 0) == WAIT_OBJECT_0) {
    CloseHandle(process); wprintf(L"absent\n"); return 3;
  }
  if (terminate) {
    if (!TerminateProcess(process, 137) || WaitForSingleObject(process, 5000) != WAIT_OBJECT_0) {
      CloseHandle(process); wprintf(L"unknown\n"); return 4;
    }
    CloseHandle(process); wprintf(L"exited\n"); return 0;
  }
  CloseHandle(process); wprintf(L"alive\n"); return 0;
}

static int utility_prelaunch_exit(int code) {
  if (GetEnvironmentVariableW(L"OUTRIGHT_UTILITY_OWNER", NULL, 0) != 0) {
    intptr_t descriptor = _get_osfhandle(3);
    DWORD written = 0;
    if (descriptor != -1)
      WriteFile((HANDLE)descriptor, UTILITY_TREE_EMPTY, sizeof(UTILITY_TREE_EMPTY) - 1, &written, NULL);
  }
  return code;
}

int wmain(int argc, wchar_t **argv) {
  if (argc < 2) return 64;
  if (wcscmp(argv[1], L"--same-file") == 0) return same_file(argc, argv);
  if (wcscmp(argv[1], L"--archive-lock") == 0) return archive_lock(argc, argv);
  if (wcscmp(argv[1], L"--identity") == 0 || wcscmp(argv[1], L"--probe") == 0
      || wcscmp(argv[1], L"--terminate") == 0) return inspect_owner(argc, argv);
  bool test_mode = wcscmp(argv[1], L"--test-runner") == 0;
  if (test_mode && argc < 4) return 64;
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (!job) return utility_prelaunch_exit(70);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return utility_prelaunch_exit(71);

  wchar_t *line = command_line(argc, argv, test_mode ? 3 : 1);
  if (!line) return utility_prelaunch_exit(72);
  // The native child owns no control input. Forward only output and error;
  // sharing the supervisor's stdin would let Git or a helper consume Stop.
  SECURITY_ATTRIBUTES inherited = {0};
  inherited.nLength = sizeof(inherited);
  inherited.bInheritHandle = TRUE;
  HANDLE null_input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
    &inherited, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (null_input == INVALID_HANDLE_VALUE) { free(line); return utility_prelaunch_exit(72); }
  HANDLE output = NULL, error_output = NULL;
  HANDLE own_process = GetCurrentProcess();
  if (!DuplicateHandle(own_process, GetStdHandle(STD_OUTPUT_HANDLE), own_process, &output,
        0, TRUE, DUPLICATE_SAME_ACCESS)
      || !DuplicateHandle(own_process, GetStdHandle(STD_ERROR_HANDLE), own_process, &error_output,
        0, TRUE, DUPLICATE_SAME_ACCESS)) {
    if (output) CloseHandle(output);
    CloseHandle(null_input);
    free(line);
    return utility_prelaunch_exit(72);
  }
  STARTUPINFOW startup = {0};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = null_input;
  startup.hStdOutput = output;
  startup.hStdError = error_output;
  bool utility_owner = GetEnvironmentVariableW(L"OUTRIGHT_UTILITY_OWNER", NULL, 0) != 0;
  intptr_t proof_handle = _get_osfhandle(3);
  if (utility_owner && (proof_handle == -1
      || !SetHandleInformation((HANDLE)proof_handle, HANDLE_FLAG_INHERIT, 0))) {
    CloseHandle(null_input); CloseHandle(output); CloseHandle(error_output); free(line);
    return utility_prelaunch_exit(72);
  }
  PROCESS_INFORMATION process = {0};
  BOOL launched = CreateProcessW(NULL, line, NULL, NULL, TRUE, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
    NULL, NULL, &startup, &process);
  CloseHandle(null_input);
  CloseHandle(output);
  CloseHandle(error_output);
  if (!launched) { free(line); return utility_prelaunch_exit(73); }
  free(line);
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    TerminateProcess(process.hProcess, 126);
    return 74;
  }
  if (ResumeThread(process.hThread) == (DWORD)-1) {
    TerminateJobObject(job, 126);
    return 75;
  }
  CloseHandle(process.hThread);

  if (!test_mode) {
    HANDLE owner_thread = CreateThread(NULL, 0, watch_owner, job, 0, NULL);
    if (owner_thread == NULL) {
      TerminateJobObject(job, 137);
      return 79;
    }
    CloseHandle(owner_thread);
  }

  if (test_mode) {
    for (;;) {
      DWORD wait = WaitForSingleObject(process.hProcess, 25);
      if (wait == WAIT_OBJECT_0) break;
      if (wait == WAIT_FAILED) { TerminateJobObject(job, 1); return 78; }
      if (GetFileAttributesW(argv[2]) != INVALID_FILE_ATTRIBUTES) {
        if (!TerminateJobObject(job, 1)) return 77;
        WaitForSingleObject(process.hProcess, INFINITE);
        break;
      }
    }
  } else WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exit_code = 1;
  GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hProcess);

  // A finished direct command must not hold a utility permit indefinitely
  // through an escaped helper. The Job Object owns and reaps that tree.
  if ((utility_owner || test_mode) && !TerminateJobObject(job, exit_code)) return 77;

  // The job owns descendants even when they detach from the provider. Keep
  // this supervisor alive until the kernel reports that the job is empty.
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {0};
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL)) return 76;
    if (accounting.ActiveProcesses == 0) break;
    Sleep(25);
  }
  if (utility_owner) {
    HANDLE proof = (HANDLE)proof_handle;
    DWORD written = 0;
    if (proof != INVALID_HANDLE_VALUE)
      WriteFile(proof, UTILITY_TREE_EMPTY, sizeof(UTILITY_TREE_EMPTY) - 1, &written, NULL);
  }
  CloseHandle(job);
  return (int)exit_code;
}
