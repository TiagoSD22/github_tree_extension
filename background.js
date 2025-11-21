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
    
    // Download and analyze files to find dependencies
    const dependencies = await findDependencies(repoInfo, relevantFiles, repoInfo.filePath);
    
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

// Find files that import the target file
async function findDependencies(repoInfo, files, targetFilePath) {
  const dependencies = [];
  const targetFileName = targetFilePath.split('/').pop();
  const targetBaseName = targetFileName.replace(/\.(js|jsx|ts|tsx|py)$/, '');
  
  // Limit concurrent requests
  const BATCH_SIZE = 10;
  
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(file => analyzeFileForImports(repoInfo, file, targetFilePath, targetBaseName))
    );
    
    batchResults.forEach(result => {
      if (result && result.imports.length > 0) {
        dependencies.push(result);
      }
    });
  }
  
  return dependencies;
}

// Analyze a single file for imports
async function analyzeFileForImports(repoInfo, filePath, targetFilePath, targetBaseName) {
  try {
    // Don't analyze the target file itself
    if (filePath === targetFilePath) {
      return null;
    }
    
    const content = await fetchFileContent(repoInfo, filePath);
    if (!content) return null;
    
    const imports = parseImports(content, targetFilePath, targetBaseName, filePath);
    
    if (imports.length > 0) {
      return {
        file: filePath,
        imports
      };
    }
    
    return null;
  } catch (error) {
    console.error(`Error analyzing ${filePath}:`, error);
    return null;
  }
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

// Parse imports from file content
function parseImports(content, targetFilePath, targetBaseName, currentFilePath) {
  const imports = [];
  const lines = content.split('\n');
  
  // Calculate relative path patterns
  const targetDir = targetFilePath.split('/').slice(0, -1).join('/');
  const currentDir = currentFilePath.split('/').slice(0, -1).join('/');
  
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    
    // JavaScript/TypeScript import patterns
    // import ... from 'path'
    const importMatch = line.match(/import\s+(?:(\{[^}]+\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(\{[^}]+\}|\*\s+as\s+\w+|\w+))?\s+from\s+)?['"]([^'"]+)['"]/);
    if (importMatch) {
      const importPath = importMatch[3];
      if (isTargetImport(importPath, targetFilePath, targetBaseName, currentDir, targetDir)) {
        imports.push({
          type: 'import',
          symbol: importMatch[1] || importMatch[2] || 'default',
          module: importPath,
          line: lineNumber
        });
      }
    }
    
    // require() pattern
    const requireMatch = line.match(/(?:const|let|var)\s+(\w+|\{[^}]+\})\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (requireMatch) {
      const importPath = requireMatch[2];
      if (isTargetImport(importPath, targetFilePath, targetBaseName, currentDir, targetDir)) {
        imports.push({
          type: 'require',
          symbol: requireMatch[1],
          module: importPath,
          line: lineNumber
        });
      }
    }
    
    // Python import patterns
    // from module import ...
    const pythonFromMatch = line.match(/from\s+([.\w]+)\s+import\s+(.+)/);
    if (pythonFromMatch) {
      const modulePath = pythonFromMatch[1];
      const symbols = pythonFromMatch[2];
      if (isPythonTargetImport(modulePath, targetFilePath, targetBaseName, currentDir)) {
        imports.push({
          type: 'from-import',
          symbol: symbols.trim(),
          module: modulePath,
          line: lineNumber
        });
      }
    }
    
    // import module
    const pythonImportMatch = line.match(/import\s+([.\w]+)(?:\s+as\s+\w+)?/);
    if (pythonImportMatch) {
      const modulePath = pythonImportMatch[1];
      if (isPythonTargetImport(modulePath, targetFilePath, targetBaseName, currentDir)) {
        imports.push({
          type: 'import',
          symbol: modulePath,
          module: modulePath,
          line: lineNumber
        });
      }
    }
  });
  
  return imports;
}

// Check if an import path refers to the target file
function isTargetImport(importPath, targetFilePath, targetBaseName, currentDir, targetDir) {
  // Normalize paths
  importPath = importPath.replace(/^\.\//, '').replace(/\\/g, '/');
  
  // Check if import path matches target file
  if (importPath === targetFilePath || 
      importPath === './' + targetFilePath ||
      importPath === '../' + targetFilePath) {
    return true;
  }
  
  // Check basename match (without extension)
  const importBaseName = importPath.split('/').pop().replace(/\.(js|jsx|ts|tsx)$/, '');
  if (importBaseName === targetBaseName) {
    // Need to verify it resolves to the same file
    const resolvedPath = resolveImportPath(importPath, currentDir);
    const targetResolved = targetFilePath.replace(/\.(js|jsx|ts|tsx)$/, '');
    
    if (resolvedPath === targetResolved || resolvedPath === targetFilePath) {
      return true;
    }
  }
  
  return false;
}

// Check if a Python import refers to the target file
function isPythonTargetImport(modulePath, targetFilePath, targetBaseName, currentDir) {
  // Convert Python module path to file path
  const moduleFilePath = modulePath.replace(/\./g, '/');
  
  // Check if it matches target
  const targetPyPath = targetFilePath.replace(/\.py$/, '');
  
  return moduleFilePath === targetPyPath || 
         moduleFilePath.endsWith('/' + targetBaseName) ||
         modulePath.endsWith('.' + targetBaseName);
}

// Resolve relative import path to absolute path
function resolveImportPath(importPath, currentDir) {
  if (importPath.startsWith('./')) {
    return currentDir + '/' + importPath.slice(2);
  } else if (importPath.startsWith('../')) {
    const parts = currentDir.split('/');
    let path = importPath;
    while (path.startsWith('../')) {
      parts.pop();
      path = path.slice(3);
    }
    return parts.join('/') + '/' + path;
  }
  return importPath;
}
