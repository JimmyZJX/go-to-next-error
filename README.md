# Go to Next Problem

This extension is a fork of https://github.com/yy0931/go-to-next-error (credit
goes to yy0931!) with code refactoring and some improvements:

-   More flexible severity conditions settings passed via command arguments
-   Supports filtering by source of markers (with priority)

This extension adds the following commands to VSCode.

-   `Go to Next Problem`
-   `Go to Previous Problem`
-   `Go to Next Problem in Files`
-   `Go to Previous Problem in Files`

These commands are like the VSCode's built-in `Go to Previous/Next Problem (Error, Warning, Info)` and `Go to Next Problem in Files (Error, Warning, Info)`, but they select only markers of the specified severity and specified source.

---

To change the behavior of the F8 key from the default `Go to Next Problem in Files (Error, Warning, Info)` to `Go to Next Problem in Files (Error, Warning)`, add the following code to the `keybinding.json` (press `F1` or `Shift+Ctrl(Cmd)+P` then `Preferences: Open Keyboard Shortcuts (JSON)`).

```json
{
    "key": "f8",
    "command": "-editor.action.marker.nextInFiles",
    "when": "editorFocus"
},
{
    "key": "f8",
    "command": "go-to-next-problem.nextInFiles",
    "when": "editorFocus"
}
```

---

To customize the severity filter, put the `severity` key inside `args`, which is
a list of the following values:

-   "error"
-   "warn" or "warning"
-   "info" or "information"
-   "hint"

For source filtering, use the `source` key with an array of glob-like patterns
with `*` (match empty or any sub-string) and `|` (for multiple patterns)
support. Note that the array indicates priority; if any marker matches a
higher-priority pattern (more to the front of the array), then the rest will be
ignored.

For example, the following keybinding matches severity "error" and jumps to the
next error that comes from "jsonc"; or any error if no "error" markers are from "jsonc".

```json
{
    "key": "f8",
    "command": "go-to-next-problem.nextInFiles",
    "args": { "severity": ["error"], "source": ["jsonc", "*"] },
    "when": "editorFocus"
}
```

## Related GitHub Issue

https://github.com/microsoft/vscode/issues/105795.

## Known problems

-   If there are multiple errors in the exact same location, only the first one will be displayed.
