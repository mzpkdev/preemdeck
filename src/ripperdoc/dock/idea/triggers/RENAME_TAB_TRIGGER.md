# Trigger: Rename Tab

Keep this JetBrains terminal tab labeled with the task in front of you, so a glance across tabs reads the work.

## Condition

The current tab name no longer fits the work. If it already reflects what you're doing, do nothing.

## Action

1. Pick a 2 to 3 word, lowercase, kebab-case slug (`auth-retry`, `proj-1234`, `flaky-ci-fix`, `dark-mode-toggle`,
   `rate-limit-bug`).
2. Run: `$HOME/.preemdeck/preemdeck-runtime "$HOME/.preemdeck/src/ripperdoc/dock/idea/toolbox/rename-tab.ts" <slug>`

## Output

Nothing to print. Never announce the rename; touch only this tab.
