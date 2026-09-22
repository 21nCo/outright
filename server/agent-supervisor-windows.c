#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

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
      if (character == L'"') *out++ = L'"';
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

static wchar_t *command_line(int argc, wchar_t **argv) {
  size_t capacity = 1;
  wchar_t **parts = calloc((size_t)argc, sizeof(*parts));
  if (!parts) return NULL;
  for (int index = 1; index < argc; index++) {
    parts[index] = quote_argument(argv[index]);
    if (!parts[index]) return NULL;
    capacity += wcslen(parts[index]) + 1;
  }
  wchar_t *line = calloc(capacity, sizeof(*line));
  if (!line) return NULL;
  for (int index = 1; index < argc; index++) {
    if (index > 1) wcscat_s(line, capacity, L" ");
    wcscat_s(line, capacity, parts[index]);
    free(parts[index]);
  }
  free(parts);
  return line;
}

int wmain(int argc, wchar_t **argv) {
  if (argc < 2) return 64;
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (!job) return 70;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 71;

  wchar_t *line = command_line(argc, argv);
  if (!line) return 72;
  STARTUPINFOW startup = {0};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process = {0};
  if (!CreateProcessW(NULL, line, NULL, NULL, TRUE, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
      NULL, NULL, &startup, &process)) return 73;
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

  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exit_code = 1;
  GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hProcess);

  // The job owns descendants even when they detach from the provider. Keep
  // this supervisor alive until the kernel reports that the job is empty.
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {0};
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL)) return 76;
    if (accounting.ActiveProcesses == 0) break;
    Sleep(25);
  }
  CloseHandle(job);
  return (int)exit_code;
}
