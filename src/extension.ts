/**
 * How to re-build and test it with VSCode:
 *  C:\MyWork\git_repos\php-codeblock-highlighter-advanced> npm install -g @vscode/vsce (only if not already done)
 *  C:\MyWork\git_repos\php-codeblock-highlighter-advanced> vsce package
 *	... this creates file 'php-codeblock-highlighter-advanced-x.x.x.vsix' in the root-dir ...
 *	
 *  Import the file 'C:\MyWork\git_repos\php-codeblock-highlighter-advanced\php-codeblock-highlighter-advanced-x.x.x.vsix' into VSCode by
 *      first removing the old extension (Ctrl + Shift + X  -> "Manage" the extension menu -> Uninstall), restart VSCode completely,
 *      then reimporting it again by (Ctrl + Shift + X  -> Click on the three-dots on the up-right -> Install from VSIX)
 *      finally: test it on some PHP project (a .php file has to be opened)
 * 
 */

import * as vscode from 'vscode';

// --- STATE VARIABLES ---
let isEnabled = true;

// 1. Full-width background for HTML lines
let blockDecorationType: vscode.TextEditorDecorationType;
// 2. Character-exact background for inline HTML text
let inlineDecorationType: vscode.TextEditorDecorationType;
// 3. Solid dark background to hide the HTML color over PHP code
let maskDecorationType: vscode.TextEditorDecorationType;
// 4. Border styling specifically for inline `echo` statements
let echoBorderDecorationType: vscode.TextEditorDecorationType; 
// 5. Fake native selection highlight to paint over our custom backgrounds
let selectionDecorationType: vscode.TextEditorDecorationType; 

let statusBarItem: vscode.StatusBarItem;

// Timers for our debounce/caching system
let fullUpdateTimeout: NodeJS.Timeout | undefined;
let selectionUpdateTimeout: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
    let activeEditor = vscode.window.activeTextEditor;

    // --- UI SETUP ---
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'togglePHPBackground';
    statusBarItem.tooltip = 'Toggle HTML/Static Background Color';
    statusBarItem.text = isEnabled ? '🎨 On' : '🎨 Off';
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();

    // --- LAYER GENERATION ---
    // Rebuilds the visual layers whenever the user changes their settings
    function createDecorations() {
        let config = vscode.workspace.getConfiguration('pchAdvanced');
        
        // Pull externalized user configurations with safe defaults suitable for dark themes
        let bgColor = config.get<string>('backgroundColor', 'rgba(255, 128, 128, 0.045)');
        let echoBorderColor = config.get<string>('echoBorderColor', 'rgba(255, 170, 0, 0.6)');
        let echoBorderStyle = config.get<string>('echoBorderStyle', 'ridge');
        let echoBorderWidth = config.get<string>('echoBorderWidth', '2px');
        let echoBorderRadius = config.get<string>('echoBorderRadius', '10px');
        let echoBackgroundColor = config.get<string>('echoBackgroundColor', 'transparent');

        // Clean up old layers before drawing new ones to prevent memory leaks
        if (blockDecorationType) blockDecorationType.dispose();
        if (inlineDecorationType) inlineDecorationType.dispose();
        if (maskDecorationType) maskDecorationType.dispose();
        if (echoBorderDecorationType) echoBorderDecorationType.dispose();
        if (selectionDecorationType) selectionDecorationType.dispose();

        // LAYER 1: Paints the entire line (edge-to-edge) if it contains HTML
        blockDecorationType = vscode.window.createTextEditorDecorationType({ backgroundColor: bgColor, isWholeLine: true });
        
        // LAYER 2: Paints exact characters for HTML on mixed lines
        inlineDecorationType = vscode.window.createTextEditorDecorationType({ backgroundColor: bgColor });
        
        // LAYER 3: The solid editor background color used to hide the HTML layer sitting underneath PHP code
        maskDecorationType = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.background') });
        
        // LAYER 4: Draws a box around inline echoes. Background is transparent so the HTML color bleeds through
        echoBorderDecorationType = vscode.window.createTextEditorDecorationType({
            borderStyle: echoBorderStyle, 
            borderWidth: echoBorderWidth, 
            borderColor: echoBorderColor, 
            borderRadius: echoBorderRadius, 
            backgroundColor: echoBackgroundColor
        });
        
        // LAYER 5: The top layer. Because our masks hide VS Code's native selection, we must draw our own over active selections
        selectionDecorationType = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.selectionBackground') });
    }

    createDecorations();

    const toggleCommand = vscode.commands.registerCommand('togglePHPBackground', () => {
        isEnabled = !isEnabled;
        statusBarItem.text = isEnabled ? '🎨 On' : '🎨 Off';
        statusBarItem.color = isEnabled ? undefined : 'rgba(255, 255, 255, 0.5)';
        triggerFullUpdate();
    });

    context.subscriptions.push(toggleCommand);

    // --- HIGH PERFORMANCE CACHE MEMORY ---
    // Storing coordinates globally so the selection engine doesn't have to re-parse the whole document
    let phpBlocks: { start: vscode.Position, end: vscode.Position }[] = [];
    let blockRanges: vscode.DecorationOptions[] = [];
    let inlineRanges: vscode.DecorationOptions[] = [];
    let maskRanges: vscode.DecorationOptions[] = [];
    let echoBorderRanges: vscode.DecorationOptions[] = [];
    let htmlLineRanges: vscode.Range[] = [];
    let inlineHtmlRanges: vscode.Range[] = [];

    // --- EVENT LISTENERS ---
    if (activeEditor) triggerFullUpdate();

    vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('pchAdvanced')) {
            createDecorations();
            triggerFullUpdate();
        }
    });

    vscode.window.onDidChangeActiveTextEditor(editor => {
        activeEditor = editor;
        if (editor) triggerFullUpdate();
    }, null, context.subscriptions);

    // Run the heavy parser ONLY when the text actually changes (typing)
    vscode.workspace.onDidChangeTextDocument(event => {
        if (activeEditor && event.document === activeEditor.document) {
            triggerFullUpdate();
        }
    }, null, context.subscriptions);

    // Lightning fast: Run the selection painter ONLY when the mouse moves/selects
    vscode.window.onDidChangeTextEditorSelection(event => {
        if (activeEditor && event.textEditor === activeEditor) {
            triggerSelectionUpdate(); 
        }
    }, null, context.subscriptions);

    // Debounce timers to protect the editor from lagging during rapid events
    function triggerFullUpdate() {
        if (fullUpdateTimeout) clearTimeout(fullUpdateTimeout);
        fullUpdateTimeout = setTimeout(fullUpdate, 50);
    }

    function triggerSelectionUpdate() {
        if (selectionUpdateTimeout) clearTimeout(selectionUpdateTimeout);
        selectionUpdateTimeout = setTimeout(selectionUpdate, 15);
    }

    // --- THE CORE PARSER ENGINE (HEAVY WORKLOAD) ---
    // Scans the document character-by-character to build the structural arrays
    function fullUpdate() {
        if (!activeEditor) return;

        if (!isEnabled || activeEditor.document.languageId !== 'php') {
            activeEditor.setDecorations(blockDecorationType, []);
            activeEditor.setDecorations(inlineDecorationType, []);
            activeEditor.setDecorations(maskDecorationType, []);
            activeEditor.setDecorations(echoBorderDecorationType, []);
            activeEditor.setDecorations(selectionDecorationType, []);
            return;
        }

        const text = activeEditor.document.getText();
        
        // Reset cache
        phpBlocks = []; blockRanges = []; inlineRanges = []; maskRanges = []; 
        echoBorderRanges = []; htmlLineRanges = []; inlineHtmlRanges = [];

        let i = 0; const len = text.length; let mode = 'HTML'; let phpStart = -1;

        // BULLETPROOF STATE MACHINE: Accurately maps PHP blocks, ignoring PHP tags hidden inside strings or comments
        while (i < len) {
            if (mode === 'HTML') {
                if (text[i] === '<' && text[i + 1] === '?') {
                    if (text.startsWith('<?php', i)) { mode = 'PHP'; phpStart = i; i += 5; continue; }
                    if (text.startsWith('<?=', i)) { mode = 'PHP'; phpStart = i; i += 3; continue; }
                    if (!text.startsWith('<?xml', i)) { mode = 'PHP'; phpStart = i; i += 2; continue; } // Ignore XML
                }
                i++;
            } else if (mode === 'PHP') {
                const c = text[i];
                if (c === '?' && text[i + 1] === '>') {
                    phpBlocks.push({ start: activeEditor.document.positionAt(phpStart), end: activeEditor.document.positionAt(i + 2) });
                    mode = 'HTML'; i += 2; continue;
                } else if (c === '"') { mode = 'STRING_D'; i++; continue; }
                  else if (c === "'") { mode = 'STRING_S'; i++; continue; }
                  else if (c === '/' && text[i + 1] === '*') { mode = 'COMMENT_B'; i += 2; continue; }
                  else if (c === '/' && text[i + 1] === '/') { mode = 'COMMENT_L'; i += 2; continue; }
                  else if (c === '#') { mode = 'COMMENT_L'; i++; continue; }
                i++;
            } else if (mode === 'STRING_D') {
                if (text[i] === '\\') { i += 2; continue; }
                if (text[i] === '"') { mode = 'PHP'; }
                i++;
            } else if (mode === 'STRING_S') {
                if (text[i] === '\\') { i += 2; continue; }
                if (text[i] === "'") { mode = 'PHP'; }
                i++;
            } else if (mode === 'COMMENT_B') {
                if (text[i] === '*' && text[i + 1] === '/') { mode = 'PHP'; i += 2; continue; }
                i++;
            } else if (mode === 'COMMENT_L') {
                if (text[i] === '\n' || text[i] === '\r') { mode = 'PHP'; i++; continue; }
                if (text[i] === '?' && text[i + 1] === '>') {
                    phpBlocks.push({ start: activeEditor.document.positionAt(phpStart), end: activeEditor.document.positionAt(i + 2) });
                    mode = 'HTML'; i += 2; continue;
                }
                i++;
            }
        }

        if (mode !== 'HTML' && phpStart !== -1) {
            phpBlocks.push({ start: activeEditor.document.positionAt(phpStart), end: activeEditor.document.positionAt(len) });
        }

        // GEOMETRY ENGINE: Determine what layers apply to what lines
        for (let i = 0; i < activeEditor.document.lineCount; i++) {
            const line = activeEditor.document.lineAt(i);
            const eolPos = line.range.end;
            let eolIsPhp = false;

            // Check if this specific line ends in PHP logic
            for (const block of phpBlocks) {
                if (block.start.compareTo(eolPos) <= 0 && block.end.compareTo(eolPos) > 0) { eolIsPhp = true; break; }
            }

            if (!eolIsPhp) {
                // IT IS AN HTML LINE (or mixed): Give it the full-width background block
                blockRanges.push({ range: line.range });
                htmlLineRanges.push(line.range); // Cache for selection painter

                for (const block of phpBlocks) {
                    if (block.start.compareTo(line.range.end) < 0 && block.end.compareTo(line.range.start) > 0) {
                        const maskStart = block.start.compareTo(line.range.start) > 0 ? block.start : line.range.start;
                        const maskEnd = block.end.compareTo(line.range.end) < 0 ? block.end : line.range.end;
                        const maskRange = new vscode.Range(maskStart, maskEnd);
                        const blockText = activeEditor.document.getText(new vscode.Range(block.start, block.end));
                        
                        // ECHO CHECK: Is this PHP block an inline echo statement sitting entirely on one line?
                        if (block.start.line === block.end.line && /^<\?(?:php[ \t]+echo|=|[ \t]*echo)/i.test(blockText)) {
                            echoBorderRanges.push({ range: maskRange }); // Apply the custom border
                        } else {
                            maskRanges.push({ range: maskRange }); // Standard PHP logic, apply solid hide mask
                        }
                    }
                }
            } else {
                // IT IS A PURE PHP LINE: No full-width blocks, just character-exact highlighting for any inline HTML
                let currentPos = line.range.start;
                for (const block of phpBlocks) {
                    if (block.end.compareTo(currentPos) <= 0) continue;
                    if (block.start.compareTo(line.range.end) >= 0) break;

                    if (currentPos.compareTo(block.start) < 0) {
                        const r = new vscode.Range(currentPos, block.start);
                        inlineRanges.push({ range: r });
                        inlineHtmlRanges.push(r); // Cache for selection painter
                    }
                    currentPos = block.end.compareTo(line.range.end) < 0 ? block.end : line.range.end;
                }
                if (currentPos.compareTo(line.range.end) < 0) {
                    const r = new vscode.Range(currentPos, line.range.end);
                    inlineRanges.push({ range: r });
                    inlineHtmlRanges.push(r); // Cache for selection painter
                }
            }
        }

        // Apply background and mask layers
        activeEditor.setDecorations(blockDecorationType, blockRanges);
        activeEditor.setDecorations(inlineDecorationType, inlineRanges);
        activeEditor.setDecorations(maskDecorationType, maskRanges);
        activeEditor.setDecorations(echoBorderDecorationType, echoBorderRanges);
        
        selectionUpdate(); // Ensure selections persist after typing
    }

    // --- LIGHTNING FAST SELECTION ENGINE ---
    // Reads from cache only, avoiding blocking VS Code's native search highlights
    function selectionUpdate() {
        if (!activeEditor || !isEnabled || activeEditor.document.languageId !== 'php') return;

        const selectionRanges: vscode.DecorationOptions[] = [];
        
        for (const sel of activeEditor.selections) {
            if (sel.isEmpty) continue; // Only paint fake blue box if actively highlighting text

            // Only paint selection over HTML parts, letting native selection handle pure PHP
            for (const htmlR of htmlLineRanges) {
                const intersection = sel.intersection(htmlR);
                if (intersection && !intersection.isEmpty) selectionRanges.push({ range: intersection });
            }
            for (const inlineR of inlineHtmlRanges) {
                const intersection = sel.intersection(inlineR);
                if (intersection && !intersection.isEmpty) selectionRanges.push({ range: intersection });
            }
        }
        // Paint the top-most fake selection layer
        activeEditor.setDecorations(selectionDecorationType, selectionRanges);
    }
}

export function deactivate() {}