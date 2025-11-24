// Background service worker
console.log('GitHub Dependency Tree background service worker started');

// Cache for repository data
const repoCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'analyzeDependencies') {
    handleAnalyzeDependencies(request.repoInfo, request.language)
      .then(sendResponse)
      .catch(error => {
        console.error('Analysis error:', error);
        sendResponse({ error: error.message });
      });
    return true; // Keep channel open for async response
  }
});

// Main analysis handler
async function handleAnalyzeDependencies(repoInfo, language) {
  console.log('Analyzing dependencies for:', repoInfo);
  
  try {
    // Get repository file tree
    const files = await getRepositoryFiles(repoInfo);
    console.log(`Found ${files.length} files in repository`);
    
    // Filter files by language
    const relevantFiles = filterFilesByLanguage(files, language);
    console.log(`Found ${relevantFiles.length} relevant files for language: ${language}`);
    
    // Build dependency map for all files (one-time cost)
    console.log('Building complete dependency map...');
    const dependencyMap = await buildDependencyMap(repoInfo, relevantFiles);
    console.log('Dependency map built');
    
    // Find recursive dependency chains using BFS
    const dependencies = await findRecursiveDependencies(dependencyMap, repoInfo.filePath);
    
    return {
      repoInfo,
      dependencies,
      filesAnalyzed: relevantFiles.length
    };
  } catch (error) {
    console.error('Error in handleAnalyzeDependencies:', error);
    throw error;
  }
}

// Fetch repository file tree from GitHub API
async function getRepositoryFiles(repoInfo) {
  const cacheKey = `${repoInfo.owner}/${repoInfo.repo}/${repoInfo.branch}`;
  const cached = repoCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log('Using cached repository data');
    return cached.files;
  }
  
  try {
    // Use GitHub's tree API to get all files
    const apiUrl = `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/git/trees/${repoInfo.branch}?recursive=1`;
    
    const response = await fetch(apiUrl);
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }
    
    const data = await response.json();
    const files = data.tree
      .filter(item => item.type === 'blob')
      .map(item => item.path);
    
    // Cache the result
    repoCache.set(cacheKey, {
      files,
      timestamp: Date.now()
    });
    
    return files;
  } catch (error) {
    console.error('Error fetching repository files:', error);
    throw new Error('Failed to fetch repository structure. You may need to authenticate for private repos.');
  }
}

// Filter files by language
function filterFilesByLanguage(files, language) {
  const extensions = {
    'javascript': ['.js', '.jsx', '.mjs'],
    'typescript': ['.ts', '.tsx'],
    'python': ['.py'],
    'jsx': ['.jsx', '.js'],
    'tsx': ['.tsx', '.ts']
  };
  
  const relevantExts = extensions[language] || extensions['javascript'];
  
  return files.filter(file => {
    const ext = '.' + file.split('.').pop();
    return relevantExts.includes(ext.toLowerCase());
  });
}

// Fetch file content from GitHub
async function fetchFileContent(repoInfo, filePath) {
  try {
    const rawUrl = `https://raw.githubusercontent.com/${repoInfo.owner}/${repoInfo.repo}/${repoInfo.branch}/${filePath}`;
    const response = await fetch(rawUrl);
    
    if (!response.ok) return null;
    
    return await response.text();
  } catch (error) {
    console.error(`Error fetching ${filePath}:`, error);
    return null;
  }
}

// ============================================
// RECURSIVE BFS SEARCH FOR DEPENDENCY CHAINS
// ============================================

// Build a complete dependency map for all files (maps each file to files that import it)
async function buildDependencyMap(repoInfo, files) {
  const dependencyMap = new Map(); // file -> Set of files that import it
  
  const BATCH_SIZE = 10;
  
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (filePath) => {
        try {
          const content = await fetchFileContent(repoInfo, filePath);
          if (!content) return;
          
          // Parse what this file imports
          const imports = parseAllImports(content, filePath);
          
          // Add reverse dependency: if A imports B, then B has A as dependent
          imports.forEach(importedFile => {
            if (!dependencyMap.has(importedFile)) {
              dependencyMap.set(importedFile, new Set());
            }
            dependencyMap.get(importedFile).add({
              file: filePath,
              imports: [{ type: 'import' }]
            });
          });
        } catch (error) {
          // Silently skip files that can't be read
        }
      })
    );
  }
  
  return dependencyMap;
}

// Parse all imports from a file (returns array of imported file paths)
function parseAllImports(content, currentFilePath) {
  const imports = [];
  const lines = content.split('\n');
  const currentDir = currentFilePath.split('/').slice(0, -1).join('/');
  
  lines.forEach((line) => {
    // JavaScript/TypeScript imports
    const jsImportMatch = line.match(/import\s+(?:(?:\{[^}]+\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]+\}|\*\s+as\s+\w+|\w+))?\s+from\s+)?['"]([^'"]+)['"]/);
    if (jsImportMatch) {
      const importPath = normalizeImportPath(jsImportMatch[1], currentDir);
      if (importPath) imports.push(importPath);
    }
    
    // CommonJS requires
    const requireMatch = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (requireMatch) {
      const importPath = normalizeImportPath(requireMatch[1], currentDir);
      if (importPath) imports.push(importPath);
    }
    
    // Python imports
    const pythonFromMatch = line.match(/from\s+([.\w]+)\s+import/);
    if (pythonFromMatch) {
      const importPath = pythonFromMatch[1].replace(/\./g, '/') + '.py';
      imports.push(importPath);
    }
    
    const pythonImportMatch = line.match(/^import\s+([.\w]+)/);
    if (pythonImportMatch) {
      const importPath = pythonImportMatch[1].replace(/\./g, '/') + '.py';
      imports.push(importPath);
    }
  });
  
  return imports;
}

// Normalize import path to file path
function normalizeImportPath(importPath, currentDir) {
  // Remove extension and add common ones
  const basePath = importPath.replace(/^\.\/|^\.\.\//, '');
  
  if (importPath.startsWith('./')) {
    return currentDir + '/' + basePath;
  } else if (importPath.startsWith('../')) {
    const parts = currentDir.split('/');
    let path = importPath;
    while (path.startsWith('../')) {
      parts.pop();
      path = path.slice(3);
    }
    return parts.join('/') + '/' + path;
  }
  
  return basePath;
}

// BFS search to find all files that depend on the target file (recursively)
async function findRecursiveDependencies(dependencyMap, targetFilePath) {
  const allDependents = [];
  const visited = new Set();
  const queue = [{
    file: targetFilePath,
    depth: 0,
    chain: [targetFilePath]
  }];
  
  // Normalize target file path
  const normalizedTarget = normalizeFilePath(targetFilePath);
  
  console.log(`Starting BFS search for dependents of ${normalizedTarget}`);
  
  while (queue.length > 0) {
    const current = queue.shift();
    const normalizedCurrent = normalizeFilePath(current.file);
    
    // Skip if already visited
    const visitKey = `${normalizedCurrent}_depth${current.depth}`;
    if (visited.has(visitKey)) {
      continue;
    }
    visited.add(visitKey);
    
    // Skip the target file itself on first iteration
    if (current.depth === 0) {
      const directDependents = findDirectDependents(dependencyMap, normalizedCurrent, targetFilePath);
      
      console.log(`Found ${directDependents.length} direct dependents of target file`);
      
      directDependents.forEach(dependent => {
        const chainEntry = {
          ...dependent,
          depth: 1,
          chain: [targetFilePath, dependent.file]
        };
        allDependents.push(chainEntry);
        queue.push({
          file: dependent.file,
          depth: 1,
          chain: chainEntry.chain
        });
      });
    } else {
      // Find dependents of this file
      const directDependents = findDirectDependents(dependencyMap, normalizedCurrent, current.file);
      
      directDependents.forEach(dependent => {
        const newChain = [...current.chain, dependent.file];
        const chainEntry = {
          ...dependent,
          depth: current.depth + 1,
          chain: newChain
        };
        allDependents.push(chainEntry);
        queue.push({
          file: dependent.file,
          depth: current.depth + 1,
          chain: newChain
        });
      });
    }
  }
  
  console.log(`BFS complete: found ${allDependents.length} total dependents`);
  return allDependents;
}

// Normalize file path for comparison
function normalizeFilePath(filePath) {
  return filePath
    .replace(/\\/g, '/')
    .replace(/\.(js|jsx|ts|tsx|py)$/, '')
    .toLowerCase();
}

// Find direct dependents of a file in the dependency map
function findDirectDependents(dependencyMap, normalizedFile, originalTargetPath) {
  const directDependents = [];
  
  // Search through all keys in the map for matches
  for (const [file, dependents] of dependencyMap) {
    const normalizedKey = normalizeFilePath(file);
    
    // Check if this key matches our target
    if (normalizedKey === normalizedFile || file === originalTargetPath) {
      dependents.forEach(dependent => {
        directDependents.push(dependent);
      });
    }
  }
  
  return directDependents;
}
