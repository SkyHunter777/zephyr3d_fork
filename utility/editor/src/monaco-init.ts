declare const __DEV__: boolean;
declare const __ZEPHYR3D_MONACO_PACKAGES__: Array<{
  name: string;
  devEntry: string;
  devRoot: string;
  prodDts: string;
  useSourceInDev: boolean;
  virtualRoot?: string;
  virtualEntryPath?: string;
}>;
declare const __ZEPHYR3D_MONACO_SOURCE_FILES__: string[];

declare global {
  interface Window {
    require?: {
      config?: (config: unknown) => void;
      (modules: string[], callback: () => void): void;
    };
  }
}

type MonacoPackage = (typeof __ZEPHYR3D_MONACO_PACKAGES__)[number];

const monacoCssHref = './vendor/monaco/vs/editor/editor.main.css';
const monacoLoaderHref = './vendor/monaco/vs/loader.js';
const monacoBaseHref = './vendor/monaco/vs';
const monacoPackages = __ZEPHYR3D_MONACO_PACKAGES__;
const zephyrPackages = monacoPackages.map((pkg) => pkg.name);
const monacoSourceFiles = new Set(__ZEPHYR3D_MONACO_SOURCE_FILES__.map((url) => resolveBrowserUrl(url)));

let monacoInitPromise: Promise<void> | null = null;

function resolveEditorAssetUrl(filePath: string) {
  return new URL(filePath.replace(/^\.?\//, ''), document.baseURI).href;
}

function resolveBrowserUrl(url: string) {
  return new URL(url, document.baseURI).href;
}

function normalizeVirtualRoot(pkg: MonacoPackage) {
  return (pkg.virtualRoot ?? `file:///node_modules/${pkg.name}`).replace(/\/+$/, '');
}

function createVirtualFileName(pkg: MonacoPackage, sourceUrl: string) {
  if (pkg.virtualEntryPath && sourceUrl === resolveBrowserUrl(pkg.devEntry)) {
    return pkg.virtualEntryPath;
  }

  const normalizedSourceUrl = sourceUrl.replace(/\\/g, '/');
  const normalizedDevRoot = resolveBrowserUrl(pkg.devRoot).replace(/\\/g, '/').replace(/\/+$/, '');
  const relativePath = normalizedSourceUrl.startsWith(normalizedDevRoot)
    ? normalizedSourceUrl.slice(normalizedDevRoot.length).replace(/^\/+/, '')
    : normalizedSourceUrl.split('/').pop() ?? 'index.ts';
  return relativePath ? `${normalizeVirtualRoot(pkg)}/${relativePath}` : `${normalizeVirtualRoot(pkg)}/index.ts`;
}

function ensureMonacoCss() {
  const existing = document.querySelector(`link[data-monaco-editor="true"]`);
  if (existing) {
    return;
  }
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = monacoCssHref;
  css.type = 'text/css';
  css.dataset.monacoEditor = 'true';
  document.head.append(css);
}

function loadScriptOnce(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
    if (existing) {
      if ((existing as any)._loaded) {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load script '${src}'`)), {
        once: true
      });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.addEventListener(
      'load',
      () => {
        (script as any)._loaded = true;
        resolve();
      },
      { once: true }
    );
    script.addEventListener('error', () => reject(new Error(`Failed to load script '${src}'`)), {
      once: true
    });
    document.head.appendChild(script);
  });
}

function requireModules(modules: string[]) {
  return new Promise<void>((resolve, reject) => {
    const req = window.require;
    if (!req) {
      reject(new Error('Monaco loader is not available'));
      return;
    }
    try {
      req(modules, () => resolve());
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function parseRelativeImports(source: string) {
  const imports = new Set<string>();
  const importExportRe =
    /\b(?:import|export)\b(?:[\s\w*{},]+from\s*)?\(\s*["']([^"']+)["']\s*\)|\b(?:import|export)\b[\s\w*{},]*from\s*["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = importExportRe.exec(source))) {
    const specifier = match[1] || match[2] || match[3];
    if (specifier?.startsWith('./') || specifier?.startsWith('../')) {
      imports.add(specifier);
    }
  }
  return [...imports];
}

function resolveRelativeCandidates(specifier: string, baseUrl: string) {
  const resolved = new URL(specifier, baseUrl);
  const href = resolved.toString();
  if (/\.[a-z0-9]+$/i.test(resolved.pathname)) {
    return monacoSourceFiles.has(href) ? [href] : [];
  }
  const base = href.endsWith('/') ? href.slice(0, -1) : href;
  return [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.d.ts`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.mjs`,
    `${base}/index.d.ts`
  ].filter((candidate) => monacoSourceFiles.has(candidate));
}

async function fetchText(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return await response.text();
}

async function tryFetchFirst(candidates: string[]) {
  for (const url of candidates) {
    try {
      const content = await fetchText(url);
      return { url, content };
    } catch {
      // Keep trying until one candidate resolves.
    }
  }
  return null;
}

async function loadDevSourceTypes(pkg: MonacoPackage, monaco: any) {
  const visited = new Set<string>();
  const pending = [resolveBrowserUrl(pkg.devEntry)];
  const defaults = monaco.languages.typescript.typescriptDefaults;

  while (pending.length > 0) {
    const currentUrl = pending.shift();
    if (!currentUrl || visited.has(currentUrl)) {
      continue;
    }
    visited.add(currentUrl);

    let content: string;
    try {
      content = await fetchText(currentUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to load ${currentUrl}:`, message);
      continue;
    }

    defaults.addExtraLib(content, createVirtualFileName(pkg, currentUrl));

    for (const specifier of parseRelativeImports(content)) {
      const resolved = await tryFetchFirst(resolveRelativeCandidates(specifier, currentUrl));
      if (resolved && !visited.has(resolved.url)) {
        pending.push(resolved.url);
      }
    }
  }
}

async function loadProdTypes(pkg: MonacoPackage, monaco: any) {
  const url = resolveEditorAssetUrl(pkg.prodDts);
  try {
    const content = await fetchText(url);
    monaco.languages.typescript.typescriptDefaults.addExtraLib(content, `${normalizeVirtualRoot(pkg)}/index.d.ts`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to load ${url}:`, message);
  }
}

async function loadTypeFiles(monaco: any) {
  for (const pkg of monacoPackages) {
    if (__DEV__ && pkg.useSourceInDev) {
      await loadDevSourceTypes(pkg, monaco);
    } else {
      await loadProdTypes(pkg, monaco);
    }
  }
}

function configureMonacoDefaults(monaco: any) {
  monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    allowNonTsExtensions: true,
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    allowJs: true,
    checkJs: false,
    strictNullChecks: false,
    noImplicitAny: false,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    strict: true,
    skipLibCheck: true,
    declaration: true,
    baseUrl: 'file:///',
    typeRoots: ['file:///node_modules/@types'],
    resolveJsonModule: true,
    experimentalDecorators: true,
    useDefineForClassFields: false
  });
}

function registerZephyrCompletionProvider(monaco: any) {
  monaco.languages.registerCompletionItemProvider('typescript', {
    triggerCharacters: ["'", '"', '/'],
    provideCompletionItems: (model: any, position: any) => {
      const textUntilPosition = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column
      });
      const importMatch = textUntilPosition.match(/import\s+.*\s+from\s+['"]([^'"]*)$/);
      if (!importMatch) {
        return { suggestions: [] };
      }
      const typedPath = importMatch[1];
      const suggestions = zephyrPackages
        .filter((pkg) => pkg.startsWith(typedPath))
        .map((pkg) => ({
          label: pkg,
          kind: monaco.languages.CompletionItemKind.Module,
          insertText: pkg,
          range: {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: position.column - typedPath.length,
            endColumn: position.column
          },
          detail: `Zephyr3D module: ${pkg}`,
          documentation: `Import from ${pkg}`
        }));
      return { suggestions };
    }
  });
}

async function initMonaco() {
  const monaco = (window as any).monaco;
  if (monaco?.languages?.typescript?.typescriptDefaults) {
    return;
  }

  ensureMonacoCss();
  await loadScriptOnce(monacoLoaderHref);

  const anchor = document.createElement('a');
  anchor.href = monacoBaseHref;
  window.require?.config?.({ paths: { vs: anchor.href } });
  (window as any).MonacoEnvironment = {
    getWorkerUrl: () => './vendor/monaco/vs/base/worker/workerMain.js'
  };

  await requireModules(['vs/editor/editor.main']);

  const readyMonaco = (window as any).monaco;
  if (!readyMonaco?.languages?.typescript?.typescriptDefaults) {
    throw new Error('Monaco initialized without TypeScript defaults');
  }

  configureMonacoDefaults(readyMonaco);
  await loadTypeFiles(readyMonaco);
  registerZephyrCompletionProvider(readyMonaco);
  window.dispatchEvent(new Event('monaco-ready'));
}

export function ensureMonacoInitialized() {
  if (!monacoInitPromise) {
    monacoInitPromise = initMonaco().catch((err) => {
      monacoInitPromise = null;
      throw err;
    });
  }
  return monacoInitPromise;
}

void ensureMonacoInitialized().catch((err) => {
  console.error('Monaco initialization failed:', err);
});
