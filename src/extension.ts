import * as vscode from "vscode";

interface Args {
    // default: ["error", "warning"]
    severity?: (
        | "error"
        | "warn"
        | "warning"
        | "info"
        | "information"
        | "hint"
    )[];
    // default: no filter; glob-like "*" matches any string (including empty)
    // priority is enforced, i.e. it loops only through the first type of
    // problem if not empty
    source?: string[];
}

function globToRe(pattern: string) {
    const rePattern = pattern
        // delibrately let '|' and '*' survive
        .replace(/[-\/\\^$+?.()[\]{}]/g, "\\$&")
        .replace(/\*/g, ".*");
    return RegExp("^" + rePattern + "$");
}

interface DiagnosticWithUri extends vscode.Diagnostic {
    uri: vscode.Uri;
}

interface DiagnosticLoc {
    range: vscode.Range;
    uri?: vscode.Uri;
}

function compareDiagnosticLoc(a: DiagnosticLoc, b: DiagnosticLoc) {
    const uria = a.uri?.toString(),
        urib = b.uri?.toString();
    if (uria === undefined || urib === undefined || uria === urib) {
        return a.range.start.isBefore(b.range.start)
            ? -1
            : a.range.start.isEqual(b.range.start)
            ? 0
            : 1;
    } else {
        return uria < urib ? -1 : 1;
    }
}

/** Sorts markers based on their start positions in ascending order, in place. */
function sortDiagnostics<D extends DiagnosticLoc>(diagnostics: D[]) {
    return diagnostics.sort(compareDiagnosticLoc);
}

function filterDiagnostics<D extends vscode.Diagnostic>(
    ds: D[],
    args: Args | undefined
): D[] {
    let severities = new Set([
        vscode.DiagnosticSeverity.Error,
        vscode.DiagnosticSeverity.Warning,
    ]);
    if (typeof args === "object" && Array.isArray(args.severity)) {
        const argSeverities = args.severity.flatMap((s) => {
            switch (s) {
                case "error":
                    return [vscode.DiagnosticSeverity.Error];
                case "warn":
                case "warning":
                    return [vscode.DiagnosticSeverity.Warning];
                case "info":
                case "information":
                    return [vscode.DiagnosticSeverity.Information];
                case "hint":
                    return [vscode.DiagnosticSeverity.Hint];
            }
        });
        if (argSeverities.length > 0) {
            severities = new Set(argSeverities);
        }
    }
    ds = ds.filter((dg) => severities.has(dg.severity));

    if (
        typeof args !== "object" ||
        !args.source ||
        !Array.isArray(args.source)
    ) {
        return ds;
    }
    for (const source of args.source) {
        if (source === "*") {
            return ds;
        }
        const reSource = globToRe(source);
        const dsOfSource = ds.filter(
            (dg) =>
                dg.source !== undefined && dg.source.match(reSource) !== null
        );
        if (dsOfSource.length > 0) {
            return dsOfSource;
        }
    }
    return [];
}

function isFilterErrorOnly(args: Args | undefined) {
    if (typeof args !== "object") return false;
    if (Array.isArray(args.severity) && args.severity[0] === "error")
        return true;
    return false;
}

/**
 * Returns either `marker` or `soFarClosest`, depending on which one is closer to and located before the current cursor position.
 * - If `soFarClosest` is null: Returns `marker` if `marker <= cursor`. Returns null otherwise.
 * - If `soFarClosest` is not null: Returns `marker` if `soFarClosest < marker <= cursor`. Returns `soFarClosest` otherwise.
 */
function getCloserPrev<D extends DiagnosticLoc>(
    cursor: DiagnosticLoc,
    marker: D,
    soFarClosest: D | null
) {
    if (soFarClosest === null) {
        return compareDiagnosticLoc(marker, cursor) < 0 ? marker : null;
    } else {
        return compareDiagnosticLoc(marker, cursor) <= 0 &&
            compareDiagnosticLoc(soFarClosest, marker) < 0
            ? marker
            : soFarClosest;
    }
}

/**
 * Returns either `marker` or `soFarClosest`, depending on which one is closer to and located after the current cursor position.
 * - If `soFarClosest` is null: Returns `marker` if `cursor <= marker`. Returns null otherwise.
 * - If `soFarClosest` is not null: Returns `marker` if `cursor <= marker < soFarClosest`. Returns `soFarClosest` otherwise.
 */
function getCloserNext<D extends DiagnosticLoc>(
    cursor: DiagnosticLoc,
    marker: D,
    soFarClosest: D | null
) {
    if (soFarClosest === null) {
        return compareDiagnosticLoc(marker, cursor) >= 0 ? marker : null;
    } else {
        return compareDiagnosticLoc(marker, cursor) >= 0 &&
            compareDiagnosticLoc(soFarClosest, marker) > 0
            ? marker
            : soFarClosest;
    }
}

export const activate = (context: vscode.ExtensionContext) => {
    /** Keep track of the last marker position to prevent selecting the same marker repeatedly */
    let lastPosition: { uri: vscode.Uri; position: vscode.Position } | null =
        null;

    /**
     * Navigates to the next/previous error in the active file.
     * @param args - Raw args passed to the command
     * @param direction - Specifies the direction of navigation.
     * @param loop - If true, when the direction is "next" and the currently active marker is the last one in the file, this function will cycle back to and select the first marker in the file. Similarly, if the direction is "prev" and the currently active marker is the first one in the file, this function will select the last marker in the file.
     * @returns true if the next/previous marker was found; This includes the case where the first marker is selected when `loop` is true. If no such marker is found, the function returns false.
     */
    const gotoMarkerInFile = async (
        args: Args | undefined,
        direction: "next" | "prev",
        loop = true
    ) => {
        // Get active text editor
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined) {
            return false;
        }

        // Get markers in the text editor that matches severity in filter
        const diagnostics = filterDiagnostics(
            vscode.languages.getDiagnostics(editor.document.uri),
            args
        );

        // Reset lastPosition if active document has changed
        if (lastPosition?.uri.toString() !== editor.document.uri.toString()) {
            lastPosition = null;
        }

        // Return if there are no diagnostics in the active text editor
        if (diagnostics.length === 0) {
            return false;
        }

        const cursor: DiagnosticLoc = { range: editor.selection };
        let next: vscode.Diagnostic | null = null;

        // Find the next/previous marker in the active text editor
        for (const d of diagnostics) {
            if (lastPosition && d.range.start.isEqual(lastPosition.position)) {
                continue;
            }

            next =
                direction === "next"
                    ? getCloserNext(cursor, d, next)
                    : getCloserPrev(cursor, d, next);
        }

        // If there is no next/previous marker and `loop` is true, then select the first/last marker in the active text editor.
        if (next === null && loop) {
            const sortedMarkers = sortDiagnostics(diagnostics);
            next =
                direction === "next"
                    ? sortedMarkers[0]
                    : sortedMarkers[sortedMarkers.length - 1];

            // TODO: I don't understand what is this bug yet
            // Fixes: When there is only one error location in the file, multiple command calls will select a non-error marker.
            if (
                lastPosition !== null &&
                lastPosition.position.isEqual(next.range.start) &&
                editor.selection.start.isEqual(next.range.start)
            ) {
                return true;
            }
        }

        if (next === null) {
            return false;
        }

        // Update `lastPosition`
        lastPosition = { position: next.range.start, uri: editor.document.uri };

        // Move the cursor to the start position of the selected marker.
        editor.selection = new vscode.Selection(
            next.range.start,
            next.range.start
        );

        await vscode.commands.executeCommand("closeMarkersNavigation"); // Issue #3

        // Show the error using either the "editor.action.marker.next" command or the "editor.action.showHover" command.
        // Due to the limitations of the VSCode API, we default to using `showHover` instead of `marker.next` when the `filter` is `[Error, Warning]`. #8
        if (isFilterErrorOnly(args)) {
            await vscode.commands.executeCommand("editor.action.marker.next");
        } else {
            // If the problem is not within the viewport
            if (
                !editor.visibleRanges.every((r) => r.contains(editor.selection))
            ) {
                // Scroll to the error location in the editor
                editor.revealRange(next.range);

                // If smooth scrolling is enabled
                if (
                    vscode.workspace
                        .getConfiguration()
                        .get<boolean>("editor.smoothScrolling")
                ) {
                    // Wait for the smooth scroll to complete before displaying the hover because scrolling hides the hover.
                    // 150ms seems to work on all platforms.
                    await new Promise((resolve) => setTimeout(resolve, 150));
                }
            }

            await vscode.commands.executeCommand("editor.action.showHover");
        }
        return true;
    };

    /**
     * Navigates to the next/previous error in the active file if one exists.
     * If not, navigates to the next/previous marker in the next text file, sorted by URI.
     * @param args - Raw args passed to the command
     * @param direction - Specifies the direction of navigation.
     */
    const gotoNextMarkerInFiles = async (
        args: Args,
        direction: "next" | "prev"
    ) => {
        // // If there is an error before/after the cursor in the file, select it.
        // if (await gotoMarkerInFile(args, direction, false)) {
        //     return;
        // }

        const diagnosticsWithUri: DiagnosticWithUri[] = vscode.languages
            .getDiagnostics()
            .flatMap(([uri, ds]) => ds.map((d) => ({ ...d, uri })));

        // List files that contain markers of the specified severities.
        const diagnostics = filterDiagnostics(diagnosticsWithUri, args);

        if (diagnostics.length === 0) {
            return;
        }

        const activeEditor = vscode.window.activeTextEditor;
        const cursor: DiagnosticLoc =
            activeEditor === undefined
                ? {
                      uri: vscode.Uri.file("/"),
                      range: new vscode.Range(0, 0, 0, 0),
                  }
                : {
                      uri: activeEditor.document.uri,
                      range: activeEditor.selection,
                  };
        let next: DiagnosticWithUri | null = null;

        // Find the next/previous marker in the active text editor
        for (const d of diagnostics) {
            if (lastPosition && d.range.start.isEqual(lastPosition.position)) {
                continue;
            }

            next =
                direction === "next"
                    ? getCloserNext(cursor, d, next)
                    : getCloserPrev(cursor, d, next);
        }

        // If there is no next/previous marker, then select the first/last marker.
        if (next === null) {
            const sortedMarkers = sortDiagnostics(diagnostics);
            next =
                direction === "next"
                    ? sortedMarkers[0]
                    : sortedMarkers[sortedMarkers.length - 1];
        }

        // Update `lastPosition`
        lastPosition = { position: next.range.start, uri: next.uri };

        // Open the document
        const editor = await vscode.window.showTextDocument(
            await vscode.workspace.openTextDocument(next.uri)
        );

        // Move the cursor to the start position of the selected marker.
        editor.selection = new vscode.Selection(
            next.range.start,
            next.range.start
        );

        await vscode.commands.executeCommand("closeMarkersNavigation"); // Issue #3

        // Show the error
        if (direction === "next") {
            await vscode.commands.executeCommand(
                "editor.action.marker.nextInFiles"
            );
        } else {
            await vscode.commands.executeCommand(
                "editor.action.marker.prevInFiles"
            );
        }
    };

    context.subscriptions.push(
        // Go to Next/Previous Problem
        vscode.commands.registerCommand("go-to-next-problem.next", (args) =>
            gotoMarkerInFile(args, "next")
        ),
        vscode.commands.registerCommand("go-to-next-problem.prev", (args) =>
            gotoMarkerInFile(args, "prev")
        ),

        // Go to Next/Previous Problem in Files
        vscode.commands.registerCommand(
            "go-to-next-problem.nextInFiles",
            (args) => gotoNextMarkerInFiles(args, "next")
        ),
        vscode.commands.registerCommand(
            "go-to-next-problem.prevInFiles",
            (args) => gotoNextMarkerInFiles(args, "prev")
        )
    );
};

export const deactivate = () => {};
