# Claude Code Features for Projects

Practical examples for setting up Claude Code infrastructure in projects built through probe.

## .claude/ Directory Structure

```
my-project/
├── CLAUDE.md                      # Project instructions (lean!)
├── .claude/
│   ├── settings.json              # Shared project settings (git-tracked)
│   ├── settings.local.json        # Local overrides (gitignored)
│   ├── CLAUDE.local.md            # Local instructions (gitignored)
│   ├── commands/                  # Slash commands
│   │   ├── test.md
│   │   └── review.md
│   ├── agents/                    # Subagents
│   └── rules/                     # Additional rules
```

## CLAUDE.md Examples

Keep it short. Only non-obvious rules.

```markdown
# My Project

## Commands
- Build: `npm run build`
- Test: `npm test`
- Lint: `npm run lint`

## Conventions
- Use named exports, not default exports
- Error types go in src/errors.ts
- All API routes return `{ data, error }` shape
```

Bad CLAUDE.md: long explanations of how TypeScript works, restating README contents, repeating framework docs.

## Slash Commands (.claude/commands/)

Each `.md` file becomes a `/project:command-name` slash command.

**`.claude/commands/test.md`**
```markdown
Run the test suite. If any tests fail, analyze the failures and fix them. After fixing, re-run to confirm all tests pass. Report a summary of what was wrong and what you changed.
```

**`.claude/commands/review.md`**
```markdown
Review all staged changes (`git diff --cached`). Check for:
1. Logic errors and edge cases
2. Security issues (injection, auth bypass, data exposure)
3. Performance problems (N+1 queries, unnecessary allocations)
4. Style violations against project conventions

Report findings grouped by severity. Don't nitpick formatting.
```

**`.claude/commands/deploy.md`**
```markdown
Pre-deploy checklist:
1. Run `npm run lint` — fix any issues
2. Run `npm test` — all must pass
3. Run `npm run build` — must succeed with no errors
4. Run `git status` — working tree must be clean
5. Report ready/not-ready with details
```

## Subagents (.claude/agents/)

Define specialized agents that sessions can delegate to via the `Task` tool.

**Code reviewer (read-only):**
```json
{
  "code-reviewer": {
    "description": "Reviews code for bugs, security issues, and style violations",
    "prompt": "You are a code reviewer. Analyze the code for correctness, security, and adherence to project conventions. Report issues by severity. Do not make changes.",
    "tools": ["Read", "Glob", "Grep"]
  }
}
```

**Test runner:**
```json
{
  "test-runner": {
    "description": "Runs tests and reports results",
    "prompt": "Run the project test suite and report results. If tests fail, analyze the failures and report root causes. Do not fix anything — just diagnose.",
    "tools": ["Read", "Glob", "Grep", "Bash"]
  }
}
```

## Settings (.claude/settings.json)

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run *)",
      "Bash(git diff *)",
      "Bash(git status)",
      "Bash(git log *)",
      "Read",
      "Glob",
      "Grep"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "Bash(git push --force *)",
      "Bash(curl *)"
    ]
  }
}
```

**Permission rule syntax:**
- `Bash(npm run *)` — commands starting with `npm run`
- `Read(.env)` — block specific file
- `Edit(/src/**/*.ts)` — glob pattern for paths
- `mcp__servername` — all tools from an MCP server
- `Task(AgentName)` — specific subagent

## Hooks

Hooks run shell commands or prompts in response to events. Define in settings.json.

**Block dangerous commands:**
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "echo $ARGUMENTS | grep -q 'rm -rf' && exit 2 || exit 0"
        }]
      }
    ]
  }
}
```

Exit code `2` = block the action. Exit code `0` = allow.

**Available hook events:** `PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `UserPromptSubmit`, `Notification`

## Permission Modes

| Mode | Use for |
|------|---------|
| `plan` | Read-only exploration. No file writes. |
| `acceptEdits` | Auto-approve file edits, prompt for bash. |
| `bypassPermissions` | Auto-approve everything. Use with `--auto-approve`. |
| `default` | Prompt for every action. |

## Key CLI Flags for Probe Sessions

```bash
# Read-only exploration
probe new -p "Explore the codebase and explain the architecture" \
  --cwd ./project --permission-mode plan --max-turns 5

# Bounded implementation
probe new -p "Implement feature X" \
  --cwd ./project --auto-approve --max-turns 20

# Cost-capped session
probe new -p "..." --auto-approve -- --max-budget-usd 2.00

# Resume a previous session
probe new -r <session-id> -p "Continue with the next step"
```
