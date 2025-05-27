// ==UserScript==
// @name         Google AI Studio Code Sidebar
// @namespace    http://tampermonkey.net/
// @version      1.5.1
// @description  Erweitert Google AI Studio um eine kollabierbare Code-Seitenleiste. Zeigt initial 5 Zeilen, Klick auf Header zeigt kompletten Code.
// @author       Daranto
// @match        https://aistudio.google.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Speichert, ob ein Code-Block den Volltext anzeigt (true) oder die Vorschau (false)
    let expandedStates = new Map();
    let currentCodeBlocks = [];
    let isModelGenerating = false;
    let lastModelTurnProcessedDOMElement = null;

    const MAIN_ACTION_BUTTON_SELECTOR = 'run-button button';
    const debouncedProcessCode = debounce(processLastModelTurnAndDisplayCode, 350);
    const PREVIEW_LINES_COUNT = 5;

    function getButtonState(buttonElement) {
        if (!buttonElement) return 'UNKNOWN';
        const isDisabled = buttonElement.getAttribute('aria-disabled') === 'true' || buttonElement.disabled;
        const labelSpan = buttonElement.querySelector('span.label');
        let labelText = '';
        if (labelSpan && labelSpan.textContent) labelText = labelSpan.textContent.trim().toLowerCase();

        if (labelText === 'stop') return 'GENERATING';

        const svgStopElement = buttonElement.querySelector('svg rect.stoppable-stop');
        if (svgStopElement && window.getComputedStyle(svgStopElement).display !== 'none') return 'GENERATING';
        const svgSpinnerElement = buttonElement.querySelector('svg circle.stoppable-spinner');
        if (svgSpinnerElement && window.getComputedStyle(svgSpinnerElement).display !== 'none') return 'GENERATING';

        const runTexts = ['run', 'senden', 'regenerate', 'ausführen', 'submit', 'neu generieren'];
        if (runTexts.includes(labelText)) {
            return isDisabled ? 'READY_BUT_DISABLED' : 'READY_TO_RUN';
        }

        const ariaLabel = buttonElement.getAttribute('aria-label');
        if (ariaLabel) {
            const ariaLabelLower = ariaLabel.toLowerCase();
            if (ariaLabelLower.includes('stop')) return 'GENERATING';
            if (ariaLabelLower.includes('run')) {
                return isDisabled ? 'READY_BUT_DISABLED' : 'READY_TO_RUN';
            }
        }
        if (isDisabled) return 'GENERATING_OR_LOADING';
        return 'UNKNOWN';
    }

    function addStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #code-sidebar {
                position: fixed; top: 0; right: 0; width: 600px; height: 100vh;
                background: #1a1a1a; border-left: 2px solid #333; z-index: 999999;
                transform: translateX(600px); transition: transform 0.3s ease;
                display: flex; flex-direction: column; font-family: 'Courier New', monospace;
                box-shadow: -5px 0 15px rgba(0,0,0,0.3);
            }
            #code-sidebar.open { transform: translateX(0); }
            #code-sidebar-toggle {
                position: absolute; left: -40px; top: 50%; transform: translateY(-50%);
                background: #007acc; color: white; border: none; padding: 15px 8px;
                cursor: pointer; border-radius: 8px 0 0 8px; font-size: 14px; font-weight: bold;
                writing-mode: vertical-lr; text-orientation: mixed; box-shadow: -3px 0 10px rgba(0,0,0,0.3);
                transition: background 0.2s ease;
            }
            #code-sidebar-toggle:hover { background: #005a9e; }
            #code-sidebar-header {
                background: #333; color: white; padding: 15px; font-size: 16px; font-weight: bold;
                border-bottom: 1px solid #555; display: flex; justify-content: space-between; align-items: center;
            }
            #code-sidebar-content { flex: 1; overflow-y: auto; padding: 0; }
            .code-block-item { border-bottom: 1px solid #333; margin: 0; }
            .code-block-header {
                background: #2d2d2d; color: #ccc; padding: 10px 15px; cursor: pointer;
                display: flex; justify-content: space-between; align-items: center;
                font-size: 12px; border-bottom: 1px solid #444;
            }
            .code-block-header:hover { background: #3d3d3d; }
            .code-block-header .toggle-icon { transition: transform 0.2s ease; margin-right: 8px; }
            .code-block-header.expanded .toggle-icon { transform: rotate(90deg); }

            .code-block-content { /* Container für Vorschau und Volltext */
                background: #1e1e1e; color: #d4d4d4; padding: 15px;
                /* max-height: 0; und transition entfernt -> immer "offen" */
                max-height: 400px; /* Feste max. Höhe für den Content, scrollt intern wenn nötig */
                overflow-y: auto;
            }
            .code-block-content pre { /* Gemeinsame Stile für Vorschau und Volltext <pre> */
                font-size: 12px; line-height: 1.4; white-space: pre-wrap;
                overflow-x: auto; margin: 0; /* Kein margin-bottom mehr hier, da nur ein <pre> sichtbar */
                background: #1e1e1e;
                padding: 5px;
                border-radius: 3px;
            }
            .code-block-content .code-full { display: none; /* Standardmäßig versteckt */ }
            /* Kein .toggle-more-button mehr */

            .copy-button {
                background: #007acc; color: white; border: none; padding: 4px 8px;
                border-radius: 3px; cursor: pointer; font-size: 10px; margin-left: 10px;
            }
            .copy-button:hover { background: #005a9e; }
            .clear-button {
                background: #dc3545; color: white; border: none; padding: 5px 10px;
                border-radius: 3px; cursor: pointer; font-size: 12px;
            }
            .clear-button:hover { background: #c82333; }
            .no-code-message { color: #888; padding: 20px; text-align: center; font-style: italic; }
        `;
        document.head.appendChild(style);
    }

    function createSidebar() {
        const sidebar = document.createElement('div');
        sidebar.id = 'code-sidebar';
        const toggle = document.createElement('button');
        toggle.id = 'code-sidebar-toggle';
        toggle.textContent = 'Code';
        sidebar.appendChild(toggle);
        const header = document.createElement('div');
        header.id = 'code-sidebar-header';
        const headerTitle = document.createElement('span');
        headerTitle.textContent = 'Code Blöcke';
        header.appendChild(headerTitle);
        const clearButton = document.createElement('button');
        clearButton.className = 'clear-button';
        clearButton.id = 'clear-codes';
        clearButton.textContent = 'Leeren';
        header.appendChild(clearButton);
        sidebar.appendChild(header);
        const content = document.createElement('div');
        content.id = 'code-sidebar-content';
        sidebar.appendChild(content);
        document.body.appendChild(sidebar);
        toggle.addEventListener('click', () => sidebar.classList.toggle('open'));
        clearButton.addEventListener('click', () => {
            expandedStates.clear();
            currentCodeBlocks = [];
            lastModelTurnProcessedDOMElement = null;
            isModelGenerating = false;
            console.log('🗑️ Sidebar manuell geleert.');
            updateSidebarDOM();
        });
    }

    function hasCodeBlocksChanged(newCodeBlocks) {
        if (currentCodeBlocks.length !== newCodeBlocks.length) return true;
        for (let i = 0; i < newCodeBlocks.length; i++) {
            if (currentCodeBlocks[i]?.element !== newCodeBlocks[i]?.element ||
                currentCodeBlocks[i]?.text !== newCodeBlocks[i]?.text ||
                currentCodeBlocks[i]?.language !== newCodeBlocks[i]?.language) {
                return true;
            }
        }
        return false;
    }

    function processLastModelTurnAndDisplayCode() {
        if (isModelGenerating) {
             console.log('PROCESS: KI generiert noch, Abbruch.');
             return;
        }
        console.log('PROCESS: Verarbeite Model-Turn für Code-Extraktion...');

        const allTurns = Array.from(document.querySelectorAll('ms-chat-turn'));
        const modelTurns = allTurns.filter(turn => turn.querySelector('ms-code-block'));
        const latestModelTurnElement = modelTurns.length > 0
            ? modelTurns[modelTurns.length - 1]
            : null;

        if (!latestModelTurnElement) {
            console.log('PROCESS: Kein letzter Model-Turn zum Verarbeiten gefunden.');
            if (lastModelTurnProcessedDOMElement || currentCodeBlocks.length > 0) {
                currentCodeBlocks = []; // Leeren, wenn kein Turn da ist, aber vorher was war
                lastModelTurnProcessedDOMElement = null;
                expandedStates.clear(); // Auch den Zustand der Blöcke zurücksetzen
                updateSidebarDOM();
            }
            return;
        }

        if (latestModelTurnElement === lastModelTurnProcessedDOMElement
            && currentCodeBlocks.length > 0
            && !document.getElementById('code-sidebar-content')?.querySelector('.no-code-message')) {
            return;
        }

        console.log('PROCESS: Verarbeite letzten Model-Turn:', latestModelTurnElement);

        const collectedItems = [];
        const uniqueTexts = new Set();

        const allCodeBlockElementsOnPage = Array.from(
          document.querySelectorAll('ms-code-block, pre code, .code-block code, pre, code')
        );

        allCodeBlockElementsOnPage.forEach(blockEl => {
            if (!latestModelTurnElement.contains(blockEl)) return;

            let codeText = '';
            if (blockEl.tagName.toLowerCase() === 'ms-code-block') {
                const preEl = blockEl.querySelector('pre');
                const codeEl = blockEl.querySelector('code');
                codeText = (preEl || codeEl || blockEl).textContent.trim();
            } else {
                codeText = blockEl.textContent.trim();
            }
            if (codeText.length < 10 || uniqueTexts.has(codeText)) return;
            uniqueTexts.add(codeText);

            let language = 'Code';
            if (blockEl.tagName.toLowerCase() === 'ms-code-block') {
                const langAttr = blockEl.getAttribute('language')
                    || blockEl.getAttribute('data-language')
                    || blockEl.getAttribute('lang');
                if (langAttr) {
                    language = langAttr.charAt(0).toUpperCase() + langAttr.slice(1);
                }
            } else {
                const className = blockEl.className || blockEl.parentElement?.className || '';
                const langMatch = className.match(/language-(\w+)|lang-(\w+)/);
                if (langMatch) {
                    const codeLang = langMatch[1] || langMatch[2];
                    language = codeLang.charAt(0).toUpperCase() + codeLang.slice(1);
                }
            }

            collectedItems.push({
                text: codeText,
                language,
                id: `code-item-${collectedItems.length + 1}`,
                element: blockEl
            });
        });

        console.log(`PROCESS: Finale Code-Items für diesen Turn: ${collectedItems.length}`);

        if (latestModelTurnElement !== lastModelTurnProcessedDOMElement
            || hasCodeBlocksChanged(collectedItems)) {
            currentCodeBlocks = [...collectedItems];
            if (latestModelTurnElement !== lastModelTurnProcessedDOMElement) {
                expandedStates.clear();
            }
            lastModelTurnProcessedDOMElement = latestModelTurnElement;
            updateSidebarDOM();
        }
    }

    function updateSidebarDOM() {
        const content = document.getElementById('code-sidebar-content');
        if (!content) { console.error("Sidebar content nicht gefunden"); return; }
        while (content.firstChild) content.removeChild(content.firstChild);

        if (isModelGenerating && currentCodeBlocks.length === 0) {
            const genMessage = document.createElement('div');
            genMessage.className = 'no-code-message';
            genMessage.textContent = 'KI generiert Code...';
            content.appendChild(genMessage);
            return;
        }

        if (currentCodeBlocks.length === 0) {
            const noCodeMessage = document.createElement('div');
            noCodeMessage.className = 'no-code-message';
            noCodeMessage.textContent = lastModelTurnProcessedDOMElement
              ? 'Keine Code-Blöcke im letzten KI-Turn.'
              : 'Keine Code-Blöcke gefunden.';
            content.appendChild(noCodeMessage);
            return;
        }

        currentCodeBlocks.forEach((item, idx) => {
            const codeBlockItem = document.createElement('div');
            codeBlockItem.className = 'code-block-item';

            const header = document.createElement('div');
            header.className = 'code-block-header';

            const toggleIcon = document.createElement('span');
            toggleIcon.className = 'toggle-icon';
            toggleIcon.textContent = '▶';
            header.appendChild(toggleIcon);

            const headerTitle = document.createElement('span');
            headerTitle.textContent = `${item.language} Block #${idx + 1}`;
            header.appendChild(headerTitle);

            const spacer = document.createElement('div');
            spacer.style.flexGrow = '1';
            header.appendChild(spacer);

            const copyButton = document.createElement('button');
            copyButton.className = 'copy-button';
            copyButton.textContent = 'Kopieren';
            copyButton.onclick = (e) => { e.stopPropagation(); copyCodeToClipboard(item.text, e.target); };
            header.appendChild(copyButton);

            const codeContentDiv = document.createElement('div');
            codeContentDiv.className = 'code-block-content'; // Immer "offen"

            const lines = item.text.split('\n');
            const previewText = lines.slice(0, PREVIEW_LINES_COUNT).join('\n');
            const hasMoreLines = lines.length > PREVIEW_LINES_COUNT;

            const previewPre = document.createElement('pre');
            previewPre.className = 'code-preview';
            previewPre.textContent = previewText;
            codeContentDiv.appendChild(previewPre);

            const fullCodePre = document.createElement('pre');
            fullCodePre.className = 'code-full';
            fullCodePre.textContent = item.text;
            // fullCodePre wird nur angehängt, wenn es mehr Zeilen gibt und gebraucht wird
            // oder immer angehängt und dann per display gesteuert. Hier: immer anhängen.
            codeContentDiv.appendChild(fullCodePre);


            const isCurrentlyShowingFullText = expandedStates.get(item.id) || false;

            if (hasMoreLines) {
                if (isCurrentlyShowingFullText) {
                    previewPre.style.display = 'none';
                    fullCodePre.style.display = 'block'; // oder 'pre'
                    header.classList.add('expanded');
                } else {
                    previewPre.style.display = 'block'; // oder 'pre'
                    fullCodePre.style.display = 'none';
                    header.classList.remove('expanded');
                }
                toggleIcon.style.visibility = 'visible';
            } else { // Weniger als PREVIEW_LINES_COUNT Zeilen
                previewPre.style.display = 'block'; // Zeigt eh den ganzen Code
                fullCodePre.style.display = 'none'; // Volltext wird nicht gebraucht
                header.classList.remove('expanded'); // Kein "expanded" Zustand
                toggleIcon.style.visibility = 'hidden'; // Icon nicht nötig
            }

            header.onclick = () => {
                if (hasMoreLines) { // Umschalten nur, wenn es Sinn macht
                    toggleCodeBlockExpansion(header, previewPre, fullCodePre, item.id);
                }
            };

            codeBlockItem.appendChild(header);
            codeBlockItem.appendChild(codeContentDiv);
            content.appendChild(codeBlockItem);
        });
        console.log('✅ Sidebar aktualisiert mit', currentCodeBlocks.length, 'Blöcken.');
    }

    function setupRunButtonObserver() {
        const callback = function() {
            const actionButton = document.querySelector(MAIN_ACTION_BUTTON_SELECTOR);
            const currentState = getButtonState(actionButton);

            if (currentState === 'GENERATING' || currentState === 'GENERATING_OR_LOADING') {
                if (!isModelGenerating) {
                    console.log('BTN_OBS: KI-Generierung gestartet.');
                    isModelGenerating = true;
                    // currentCodeBlocks und lastModelTurnProcessedDOMElement nicht sofort leeren,
                    // um Flackern zu vermeiden. updateSidebarDOM() zeigt "Generiere..." wenn nötig.
                    updateSidebarDOM();
                }
            } else if (currentState === 'READY_BUT_DISABLED' || currentState === 'READY_TO_RUN') {
                if (isModelGenerating) {
                    console.log('BTN_OBS: KI-Generierung beendet. Starte Code-Extraktion.');
                    isModelGenerating = false;
                    debouncedProcessCode();
                }
            }
        };

        const observer = new MutationObserver(debounce(callback, 150));
        let watchTarget = document.querySelector('div.button-wrapper run-button')
                         || document.querySelector('ms-composer-send-controls')
                         || document.body;
        observer.observe(watchTarget, {
            childList: true, subtree: true, attributes: true,
            attributeFilter: ['aria-label', 'disabled', 'class', 'style']
        });
        console.log('👁️ Run/Stop Button Observer gestartet auf:', watchTarget);

        setTimeout(() => {
            const actionButton = document.querySelector(MAIN_ACTION_BUTTON_SELECTOR);
            const initialState = getButtonState(actionButton);
            isModelGenerating = (initialState === 'GENERATING' || initialState === 'GENERATING_OR_LOADING');
            // Initialen Zustand rendern
            if (!isModelGenerating && document.querySelectorAll('ms-chat-turn').length > 0) {
                console.log('Initial: Verarbeite bereits vorhandene Model-Turns.');
                processLastModelTurnAndDisplayCode(); // Dies ruft updateSidebarDOM
            } else {
                updateSidebarDOM(); // Stellt sicher, dass "Generiere..." oder "Kein Code" angezeigt wird
            }
        }, 2500);
    }

    function toggleCodeBlockExpansion(headerElement, previewElement, fullElement, codeItemId) {
        // Der Check 'hasMoreLines' wurde bereits im Aufrufer (header.onclick) gemacht
        const isNowExpanded = headerElement.classList.toggle('expanded');
        expandedStates.set(codeItemId, isNowExpanded);

        if (isNowExpanded) {
            previewElement.style.display = 'none';
            fullElement.style.display = 'block'; // oder 'pre'
        } else {
            previewElement.style.display = 'block'; // oder 'pre'
            fullElement.style.display = 'none';
        }
    }

    function copyCodeToClipboard(text, buttonElement) {
        navigator.clipboard.writeText(text).then(() => {
            const orig = buttonElement.textContent;
            buttonElement.textContent = 'Kopiert!';
            buttonElement.disabled = true;
            setTimeout(() => {
                buttonElement.textContent = orig;
                buttonElement.disabled = false;
            }, 1500);
        }).catch(err => {
            console.error('Fehler beim Kopieren:', err);
            const orig = buttonElement.textContent;
            buttonElement.textContent = 'Fehler!';
            setTimeout(() => { buttonElement.textContent = orig; }, 1500);
        });
    }

    function debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    function init() {
        console.log(`🚀 Google AI Studio Code Sidebar - Initialisierung v1.5.1 (Preview: ${PREVIEW_LINES_COUNT} Zeilen)`);
        addStyles();
        createSidebar();
        setupRunButtonObserver();
        console.log('✅ Google AI Studio Code Sidebar vollständig geladen.');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
