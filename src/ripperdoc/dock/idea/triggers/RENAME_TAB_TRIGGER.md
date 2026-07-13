# Trigger: Rename Tab

Keep this JetBrains terminal tab labeled with the task in front of you, so a glance across tabs reads the work.

## Condition

The current tab name no longer fits the work. If it already reflects what you're doing, do nothing.

## Action

1. Pick a 2 to 3 word Title Case name (`Auth Retry`, `Notify Title`, `Flaky CI`, `Dark Mode Toggle`); keep acronyms
   uppercase (PR, CI, API).
2. Run (quote it, the name has spaces):
   `$HOME/.preemdeck/preemdeck-runtime "$HOME/.preemdeck/src/ripperdoc/dock/idea/toolbox/rename-tab.ts" "<name>"`

## Output

Nothing to print. Never announce the rename; touch only this tab.
