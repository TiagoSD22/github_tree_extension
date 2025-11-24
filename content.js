// Content script - runs on GitHub file pages
console.log('GitHub Dependency Tree extension loaded');

let overlay = null;
let isAnalyzing = false;

// Extract repository information from GitHub URL
function getRepoInfo() {
  const pathParts = window.location.pathname.split('/');
  if (pathParts.length < 5 || pathParts[3] !== 'blob') {
    return null;
  }
  
  return {
    owner: pathParts[1],
    repo: pathParts[2],
    branch: pathParts[4],
    filePath: pathParts.slice(5).join('/')
  };
}

// Extract current file content from GitHub's DOM
function getCurrentFileContent() {
  // GitHub's file view structure
  const codeElement = document.querySelector('.blob-wrapper table.js-file-line-container');
  if (!codeElement) return null;
  
  const lines = codeElement.querySelectorAll('tr');
  const content = Array.from(lines).map(line => {
    const td = line.querySelector('td.blob-code');
    return td ? td.textContent : '';
  }).join('\n');
  
  return content;
}

// Determine file language from GitHub's metadata
function getFileLanguage() {
  const langElement = document.querySelector('[data-code-language]');
  if (langElement) {
    return langElement.getAttribute('data-code-language');
  }
  
  // Fallback: detect from file extension
  const repoInfo = getRepoInfo();
  if (!repoInfo) return null;
  
  const ext = repoInfo.filePath.split('.').pop().toLowerCase();
  const langMap = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'java': 'java',
    'go': 'go',
    'rb': 'ruby',
    'php': 'php',
    'cs': 'csharp'
  };
  
  return langMap[ext] || ext;
}

// Create and show the overlay UI
function createOverlay() {
  if (overlay) {
    overlay.remove();
  }
  
  overlay = document.createElement('div');
  overlay.id = 'dep-tree-overlay';
  overlay.innerHTML = `
    <div class="dep-tree-header">
      <h3>📊 Dependency Analysis</h3>
      <button id="dep-tree-close">×</button>
    </div>
    <div class="dep-tree-content">
      <div class="dep-tree-loading">Analyzing dependencies...</div>
    </div>
  `;
  
  document.body.appendChild(overlay);
  
  // Close button handler
  document.getElementById('dep-tree-close').addEventListener('click', () => {
    overlay.remove();
    overlay = null;
  });
}

// Update overlay with dependency data
function updateOverlay(data) {
  if (!overlay) return;
  
  const content = overlay.querySelector('.dep-tree-content');
  
  if (data.error) {
    content.innerHTML = `<div class="dep-tree-error">❌ ${data.error}</div>`;
    return;
  }
  
  if (!data.dependencies || data.dependencies.length === 0) {
    content.innerHTML = `
      <div class="dep-tree-empty">
        <p>No files found that import this file.</p>
        <small>Analysis completed for ${data.filesAnalyzed || 0} files</small>
      </div>
    `;
    return;
  }
  
  // Group dependencies by depth for better visualization
  const depsByDepth = {};
  data.dependencies.forEach(dep => {
    const depth = dep.depth || 0;
    if (!depsByDepth[depth]) {
      depsByDepth[depth] = [];
    }
    depsByDepth[depth].push(dep);
  });
  
  // Build dependency tree HTML
  let html = `
    <div class="dep-tree-stats">
      <span>Found <strong>${data.dependencies.length}</strong> dependent file(s)</span>
      <span>Analyzed ${data.filesAnalyzed || 0} files</span>
    </div>
    <div class="dep-tree-list">
  `;
  
  // Render by depth level
  Object.keys(depsByDepth).sort((a, b) => a - b).forEach(depth => {
    if (parseInt(depth) > 0) {
      html += `<div class="dep-tree-level" data-level="${depth}">
        <div class="dep-tree-level-header">📍 Level ${depth} Dependencies</div>`;
    }
    
    depsByDepth[depth].forEach(dep => {
      const fileName = dep.file.split('/').pop();
      const fileDir = dep.file.substring(0, dep.file.lastIndexOf('/'));
      
      html += `
        <div class="dep-item" data-depth="${dep.depth || 0}">
          <div class="dep-file">
            <a href="/${data.repoInfo.owner}/${data.repoInfo.repo}/blob/${data.repoInfo.branch}/${dep.file}" 
               target="_blank" title="${dep.file}">
              📄 ${fileName}
            </a>
            ${fileDir ? `<div class="dep-file-path">${fileDir}</div>` : ''}
          </div>
          ${dep.chain && dep.chain.length > 1 ? `
            <div class="dep-chain">
              <div class="dep-chain-label">Chain:</div>
              <div class="dep-chain-path">
                ${dep.chain.map((f, i) => `
                  <span class="dep-chain-item" title="${f}">
                    ${f.split('/').pop()}
                    ${i < dep.chain.length - 1 ? '<span class="dep-chain-arrow">→</span>' : ''}
                  </span>
                `).join('')}
              </div>
            </div>
          ` : ''}
        </div>
      `;
    });
    
    if (parseInt(depth) > 0) {
      html += '</div>';
    }
  });
  
  html += '</div>';
  content.innerHTML = html;
}

// Add button to GitHub's UI
function addAnalyzeButton() {
  // Remove existing button if present
  const existing = document.getElementById('dep-tree-analyze-btn');
  if (existing) existing.remove();
  
  // Try multiple selectors to find GitHub's file actions area
  const selectors = [
    '.react-code-view-header-element--wide .d-flex.gap-2',
    '.CodeViewHeader-module__Box_7--FZfkg .d-flex.gap-2',
    '[data-testid="file-name-and-actions"]',
    '.file-header .file-actions',
    '[data-testid="breadcrumbs"]',
    '.Box-header .d-flex'
  ];
  
  let actionsBar = null;
  for (const selector of selectors) {
    actionsBar = document.querySelector(selector);
    if (actionsBar) {
      console.log(`Found GitHub actions bar using selector: ${selector}`);
      break;
    }
  }
  
  if (!actionsBar) {
    console.log('Could not find GitHub file actions bar, adding floating button instead');
    addFloatingButton();
    return false;
  }
  
  const button = document.createElement('button');
  button.id = 'dep-tree-analyze-btn';
  button.type = 'button';
  // Match GitHub's button styles
  button.className = 'prc-Button-ButtonBase-c50BI Button__StyledButtonComponent-sc-vqy3e4-0 NavigationMenu-module__Button--SJihq';
  button.setAttribute('data-loading', 'false');
  button.setAttribute('data-no-visuals', 'true');
  button.setAttribute('data-size', 'medium');
  button.setAttribute('data-variant', 'default');
  
  // Create button content matching GitHub structure
  button.innerHTML = `
    <span data-component="buttonContent" data-align="center" class="prc-Button-ButtonContent-HKbr-">
      <span data-component="text" class="prc-Button-Label-pTQ3x">📊 Dependencies</span>
    </span>
  `;
  
  button.addEventListener('click', analyzeDependencies);
  
  // Insert at the beginning
  actionsBar.insertBefore(button, actionsBar.firstChild);
  console.log('Successfully added dependency button to GitHub UI');
  return true;
}

// Main analysis function
async function analyzeDependencies() {
  if (isAnalyzing) return;
  
  const repoInfo = getRepoInfo();
  if (!repoInfo) {
    alert('Could not determine repository information');
    return;
  }
  
  const language = getFileLanguage();
  const supportedLanguages = ['javascript', 'typescript', 'python', 'jsx', 'tsx'];
  
  if (!supportedLanguages.includes(language)) {
    alert(`Language "${language}" is not yet supported. Currently supporting: JavaScript, TypeScript, Python`);
    return;
  }
  
  isAnalyzing = true;
  createOverlay();
  
  // Send message to background script to analyze repo
  chrome.runtime.sendMessage({
    action: 'analyzeDependencies',
    repoInfo: repoInfo,
    language: language
  }, (response) => {
    isAnalyzing = false;
    if (response) {
      updateOverlay(response);
    }
  });
}

// Add floating action button as fallback
function addFloatingButton() {
  // Remove existing if present
  const existing = document.getElementById('dep-tree-floating-btn');
  if (existing) existing.remove();
  
  const button = document.createElement('button');
  button.id = 'dep-tree-floating-btn';
  button.className = 'dep-tree-fab';
  button.innerHTML = '📊';
  button.title = 'Show Dependencies';
  button.addEventListener('click', analyzeDependencies);
  
  document.body.appendChild(button);
  console.log('Added floating action button');
}

// Initialize when page loads
function initialize() {
  const repoInfo = getRepoInfo();
  if (repoInfo) {
    console.log('Initializing GitHub Dependency Tree for:', repoInfo.filePath);
    
    // Try to add button to GitHub UI
    const success = addAnalyzeButton();
    
    // If initial injection failed, retry after GitHub finishes rendering
    if (!success) {
      setTimeout(() => {
        const retrySuccess = addAnalyzeButton();
        if (!retrySuccess) {
          console.log('All injection attempts failed, floating button was added');
        }
      }, 1000);
    }
  }
}

// Watch for GitHub's soft navigation (PJAX)
let lastUrl = location.href;
new MutationObserver(() => {
  const currentUrl = location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    setTimeout(initialize, 500); // Give GitHub time to render
  }
}).observe(document, { subtree: true, childList: true });

// Initial load - try multiple times as GitHub renders async
initialize();
setTimeout(initialize, 1000);
setTimeout(initialize, 2000);
