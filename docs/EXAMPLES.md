# Things to try with FreeAgent

These are example prompts, not recorded demonstrations. Start with a disposable workspace and review code before approving execution.

## Build a small CLI

```text
Create a Python expense tracker in this workspace.
Support adding expenses, CSV import and a monthly summary.
Use only the Python standard library.
Write useful tests, run them, and explain how to use the CLI.
Do not install packages or access other folders.
```

Expected tools: file operations, `run_python` and optionally project memory. Inspect the resulting code and test output in the conversation.

## Index a folder

```text
Inspect the Markdown and text files in this workspace.
Create INDEX.md with each relative path and a short summary.
Do not modify existing documents, rename files or delete anything.
Show which files you could not read completely.
```

Expected tools: directory listing, search, reads and a new file. Request chunks when results are truncated.

## Remember a project

```text
Read this project's README and top-level source files.
Remember its purpose, main entry points and test command.
Create task notes for the next three improvements.
Do not execute code or change source files.
```

In a new chat, ask the agent to read workspace memory and tasks. Notes persist in `.freeagent/state.sqlite3`; they are not scheduled jobs.

## Create a reusable skill

```text
Create skills/review.md with a checklist for reviewing this project:
understand the change, inspect affected code, check failure behavior,
run relevant tests after approval, and report evidence clearly.
Then list the available skills and read this one back.
```

Skills are Markdown files in the workspace's `skills/` directory. The included [coding skill](../workspace/skills/coding.md) is a starting point.

## Optional desktop inspection

```text
Take one screenshot of my desktop and describe what is visible.
Do not click, type, open pages or make changes.
```

Requires optional desktop dependencies and OS permissions. Approval sends the screenshot to your chat provider. ChatGPT's adapter currently disables image uploads; use a compatible provider and respect its limits.
