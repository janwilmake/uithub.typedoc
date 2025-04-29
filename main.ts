import * as ts from "typescript";

interface FileInput {
  name: string;
  content: string;
}

interface PackageJson {
  name?: string;
  exports?: Record<string, string | Record<string, string>>;
  main?: string;
  types?: string;
  typings?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  compilerOptions?: ts.CompilerOptions;
}

interface DeclarationResult {
  files: Record<string, string>; // Map of filename to declaration content
  errors: string[];
  success: boolean;
  warnings?: string[]; // New field for non-critical issues
}

interface GenerateOptions {
  filterToExports?: boolean;
  resolveExternalDependencies?: boolean;
  timeoutMs?: number;
  maxMemoryMb?: number;
  includeDeclarationMap?: boolean;
}

/**
 * Helper function to normalize paths
 */
function normalizePath(path: string): string {
  // Remove leading ./ if present
  if (path.startsWith("./")) {
    path = path.substring(2);
  }
  // Remove leading / if present
  if (path.startsWith("/")) {
    path = path.substring(1);
  }
  return path;
}

/**
 * Extract entry points from a package.json file
 */
function getPackageEntryPoints(packageJson: PackageJson): string[] {
  const entryPoints: string[] = [];

  // Add main entry point if it exists
  if (packageJson.main) {
    entryPoints.push(packageJson.main);
  }

  // Add types/typings entry point if it exists
  if (packageJson.types) {
    entryPoints.push(packageJson.types);
  } else if (packageJson.typings) {
    entryPoints.push(packageJson.typings);
  }

  // Handle exports field (ESM-style package)
  if (packageJson.exports) {
    const processExports = (exports: any, path = "") => {
      if (typeof exports === "string") {
        entryPoints.push(exports);
      } else if (typeof exports === "object") {
        for (const [key, value] of Object.entries(exports)) {
          // Skip conditions like 'import', 'require', etc.
          if (key.startsWith(".")) {
            const fullPath = path + key;
            if (typeof value === "string") {
              entryPoints.push(value);
            } else if (typeof value === "object") {
              processExports(value, fullPath);
            }
          } else if (
            value &&
            typeof value === "object" &&
            !Array.isArray(value)
          ) {
            // Handle conditions like "import", "require", etc.
            for (const conditionValue of Object.values(value)) {
              if (typeof conditionValue === "string") {
                entryPoints.push(conditionValue);
              }
            }
          }
        }
      }
    };

    processExports(packageJson.exports);
  }

  // Normalize all paths and convert to .ts if they're .js
  return entryPoints
    .map(normalizePath)
    .map((path) => path.replace(/\.js$/, ".ts"))
    .map((path) => path.replace(/\.d\.ts$/, ".ts"))
    .map((path) => path.replace(/\.mjs$/, ".ts"))
    .map((path) => path.replace(/\.cjs$/, ".ts"));
}

/**
 * Get external dependencies from package.json
 */
function getExternalDependencies(packageJson: PackageJson): string[] {
  if (!packageJson) return [];

  const dependencies: string[] = [];

  // Add production dependencies
  if (packageJson.dependencies) {
    dependencies.push(...Object.keys(packageJson.dependencies));
  }

  // Add dev dependencies
  if (packageJson.devDependencies) {
    dependencies.push(...Object.keys(packageJson.devDependencies));
  }

  return dependencies;
}

/**
 * Create shim type definitions for common external dependencies
 */
function createExternalDependencyShims(
  dependencies: string[],
): Record<string, string> {
  const shims: Record<string, string> = {};

  // Add shims for common libraries
  for (const dep of dependencies) {
    let shim = "";

    // Create specific shims for well-known packages
    if (dep === "react") {
      shim = `
        declare namespace React {
          interface FunctionComponent<P = {}> {
            (props: P & { children?: React.ReactNode }): React.ReactElement | null;
          }
          
          interface ReactElement {
            type: any;
            props: any;
            key: string | null;
          }
          
          type ReactNode = ReactElement | string | number | boolean | null | undefined;
          
          function createElement(type: any, props?: any, ...children: any[]): ReactElement;
          function Fragment(props: { children?: ReactNode }): ReactElement;
        }
        
        declare module "react" {
          export = React;
        }
      `;
    } else if (dep === "lodash") {
      shim = `
        declare module "lodash" {
          export function map<T, U>(array: T[], iteratee: (value: T) => U): U[];
          export function filter<T>(array: T[], predicate: (value: T) => boolean): T[];
          export function reduce<T, U>(array: T[], iteratee: (accumulator: U, value: T) => U, initialValue: U): U;
          export function get(object: any, path: string | string[], defaultValue?: any): any;
          export function merge(object: any, ...sources: any[]): any;
          export function cloneDeep<T>(value: T): T;
        }
      `;
    } else {
      // Generic shim for other packages
      shim = `
        declare module "${dep}" {
          const content: any;
          export = content;
          export default content;
        }
      `;
    }

    const modulePath = `node_modules/${dep}/index.d.ts`;
    shims[modulePath] = shim;
  }

  return shims;
}

/**
 * Filter declaration files to only include those relevant to package exports
 * and their dependencies
 */
function filterRelevantDeclarations(
  allDeclarations: Record<string, string>,
  packageJson: PackageJson | null,
  program: ts.Program,
): Record<string, string> {
  // If no package.json, return all declarations
  if (!packageJson) {
    return allDeclarations;
  }

  const relevantFiles = new Set<string>();
  const entryPoints = getPackageEntryPoints(packageJson);

  if (entryPoints.length === 0) {
    // No entry points found, return all declarations
    return allDeclarations;
  }

  // Function to add a file and all its dependencies
  const addFileAndDependencies = (sourceFile: ts.SourceFile) => {
    const dtsPath = sourceFile.fileName.replace(/\.tsx?$/, ".d.ts");

    // If we've already processed this file or it doesn't have a declaration, skip
    if (relevantFiles.has(dtsPath) || !allDeclarations[dtsPath]) {
      return;
    }

    // Add this file's declaration
    relevantFiles.add(dtsPath);

    // Process all imports recursively
    sourceFile.forEachChild((node) => {
      if (
        ts.isImportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const importPath = node.moduleSpecifier.text;

        // Handle relative imports
        if (importPath.startsWith(".")) {
          // Resolve the import path relative to the current file
          const baseDir = sourceFile.fileName.split("/").slice(0, -1).join("/");
          const resolvedPath = ts.resolveModuleName(
            importPath,
            sourceFile.fileName,
            program.getCompilerOptions(),
            {
              fileExists: (f) => program.getSourceFile(f) !== undefined,
              readFile: () => "",
            },
          ).resolvedModule?.resolvedFileName;

          if (resolvedPath) {
            const importedFile = program.getSourceFile(resolvedPath);
            if (importedFile) {
              addFileAndDependencies(importedFile);
            }
          }
        }
      }
    });
  };

  // Start with entry points
  for (const entryPoint of entryPoints) {
    const sourceFile = program.getSourceFile(entryPoint);
    if (sourceFile) {
      addFileAndDependencies(sourceFile);
    }
  }

  // If no relevant files found, return all declarations
  if (relevantFiles.size === 0) {
    return allDeclarations;
  }

  // Return only relevant declarations
  const filteredDeclarations: Record<string, string> = {};
  for (const file of relevantFiles) {
    if (allDeclarations[file]) {
      filteredDeclarations[file] = allDeclarations[file];
    }
  }

  return filteredDeclarations;
}

/**
 * Enhanced lib.d.ts with more types for common usage
 */
function getEnhancedLibDeclaration(): string {
  return `
  // Basic types
  interface Array<T> { 
    length: number; 
    [n: number]: T;
    map<U>(callbackfn: (value: T, index: number, array: T[]) => U): U[];
    filter(predicate: (value: T, index: number, array: T[]) => boolean): T[];
    find(predicate: (value: T, index: number, array: T[]) => boolean): T | undefined;
    forEach(callbackfn: (value: T, index: number, array: T[]) => void): void;
    reduce<U>(callbackfn: (previousValue: U, currentValue: T) => U, initialValue: U): U;
    push(...items: T[]): number;
    pop(): T | undefined;
    slice(start?: number, end?: number): T[];
    splice(start: number, deleteCount?: number, ...items: T[]): T[];
    concat(...items: (T | T[])[]): T[];
    indexOf(searchElement: T, fromIndex?: number): number;
    join(separator?: string): string;
    some(predicate: (value: T, index: number, array: T[]) => boolean): boolean;
    every(predicate: (value: T, index: number, array: T[]) => boolean): boolean;
  }
  
  interface Boolean { valueOf(): boolean; }
  
  interface CallableFunction extends Function { }
  
  interface Function { 
    apply(this: Function, thisArg: any, argArray?: any): any;
    call(this: Function, thisArg: any, ...argArray: any[]): any;
    bind(this: Function, thisArg: any, ...argArray: any[]): any;
  }
  
  interface IArguments { length: number; callee: Function; }
  
  interface Number { 
    valueOf(): number; 
    toFixed(fractionDigits?: number): string;
    toString(radix?: number): string;
  }
  
  interface Object { 
    toString(): string;
    hasOwnProperty(v: PropertyKey): boolean;
    valueOf(): Object;
  }
  
  interface RegExp { 
    exec(string: string): RegExpExecArray | null;
    test(string: string): boolean;
    source: string;
    global: boolean;
    ignoreCase: boolean;
    multiline: boolean;
  }
  
  interface String { 
    charAt(pos: number): string;
    charCodeAt(index: number): number;
    concat(...strings: string[]): string;
    indexOf(searchString: string, position?: number): number;
    lastIndexOf(searchString: string, position?: number): number;
    match(regexp: string | RegExp): RegExpMatchArray | null;
    replace(searchValue: string | RegExp, replaceValue: string): string;
    replace(searchValue: string | RegExp, replacer: (substring: string, ...args: any[]) => string): string;
    slice(start?: number, end?: number): string;
    split(separator: string | RegExp, limit?: number): string[];
    substring(start: number, end?: number): string;
    toLowerCase(): string;
    toUpperCase(): string;
    trim(): string;
    length: number;
  }
  
  interface Date {
    getDate(): number;
    getDay(): number;
    getFullYear(): number;
    getHours(): number;
    getMinutes(): number;
    getMonth(): number;
    getSeconds(): number;
    getTime(): number;
    toISOString(): string;
    toJSON(): string;
    toString(): string;
  }
  
  interface PromiseConstructor {
    new <T>(executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void): Promise<T>;
    all<T>(values: (T | PromiseLike<T>)[]): Promise<T[]>;
    race<T>(values: (T | PromiseLike<T>)[]): Promise<T>;
    resolve<T>(value: T | PromiseLike<T>): Promise<T>;
    reject<T = never>(reason?: any): Promise<T>;
  }
  
  interface Promise<T> {
    then<TResult1 = T, TResult2 = never>(
      onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2>;
    catch<TResult = never>(
      onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null
    ): Promise<T | TResult>;
    finally(onfinally?: (() => void) | null): Promise<T>;
  }
  
  declare var Promise: PromiseConstructor;
  
  interface ErrorConstructor {
    new(message?: string): Error;
    (message?: string): Error;
    readonly prototype: Error;
  }
  
  interface Error {
    name: string;
    message: string;
    stack?: string;
  }
  
  declare var Error: ErrorConstructor;
  
  interface Console {
    log(...data: any[]): void;
    error(...data: any[]): void;
    warn(...data: any[]): void;
    info(...data: any[]): void;
    debug(...data: any[]): void;
  }
  
  declare var console: Console;
  
  declare var Math: {
    floor(x: number): number;
    ceil(x: number): number;
    round(x: number): number;
    random(): number;
    abs(x: number): number;
    max(...values: number[]): number;
    min(...values: number[]): number;
    pow(x: number, y: number): number;
    sqrt(x: number): number;
    PI: number;
  };
  
  // Utility types
  type Partial<T> = { [P in keyof T]?: T[P]; };
  type Required<T> = { [P in keyof T]-?: T[P]; };
  type Readonly<T> = { readonly [P in keyof T]: T[P]; };
  type Pick<T, K extends keyof T> = { [P in K]: T[P]; };
  type Omit<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>>;
  type Exclude<T, U> = T extends U ? never : T;
  type Extract<T, U> = T extends U ? T : never;
  type NonNullable<T> = T extends null | undefined ? never : T;
  type Parameters<T extends (...args: any) => any> = T extends (...args: infer P) => any ? P : never;
  type ReturnType<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R : any;
  type InstanceType<T extends new (...args: any) => any> = T extends new (...args: any) => infer R ? R : any;
  
  // DOM types for browser environments
  interface Element {
    id: string;
    className: string;
    classList: DOMTokenList;
    tagName: string;
    innerHTML: string;
    outerHTML: string;
    textContent: string | null;
    attributes: NamedNodeMap;
    style: CSSStyleDeclaration;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    hasAttribute(name: string): boolean;
    querySelector(selectors: string): Element | null;
    querySelectorAll(selectors: string): NodeListOf<Element>;
  }
  
  interface Document extends Node {
    createElement(tagName: string): HTMLElement;
    createElementNS(namespaceURI: string, qualifiedName: string): Element;
    createTextNode(data: string): Text;
    getElementById(elementId: string): HTMLElement | null;
    getElementsByClassName(classNames: string): HTMLCollectionOf<Element>;
    getElementsByTagName(qualifiedName: string): HTMLCollectionOf<HTMLElement>;
    querySelector(selectors: string): Element | null;
    querySelectorAll(selectors: string): NodeListOf<Element>;
    body: HTMLElement;
    head: HTMLElement;
    documentElement: HTMLElement;
  }
  
  interface Event {
    readonly type: string;
    readonly target: EventTarget | null;
    readonly currentTarget: EventTarget | null;
    preventDefault(): void;
    stopPropagation(): void;
    stopImmediatePropagation(): void;
  }
  
  interface EventTarget {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
    dispatchEvent(event: Event): boolean;
  }
  
  interface HTMLElement extends Element {}
  interface HTMLInputElement extends HTMLElement {
    value: string;
    checked: boolean;
    type: string;
    disabled: boolean;
    readOnly: boolean;
    placeholder: string;
  }
  interface HTMLButtonElement extends HTMLElement {
    disabled: boolean;
  }
  
  // Node environment
  interface Process {
    env: Record<string, string | undefined>;
    argv: string[];
    cwd(): string;
    exit(code?: number): never;
    nextTick(callback: (...args: any[]) => void, ...args: any[]): void;
  }
  
  declare var process: Process;
  
  interface Buffer extends Uint8Array {
    toString(encoding?: string): string;
    write(string: string, encoding?: string): number;
    from(arrayBuffer: ArrayBuffer): Buffer;
    from(string: string, encoding?: string): Buffer;
  }
  
  declare var Buffer: {
    from(arrayBuffer: ArrayBuffer): Buffer;
    from(string: string, encoding?: string): Buffer;
    isBuffer(obj: any): boolean;
    alloc(size: number): Buffer;
  };
  `;
}

/**
 * Generates TypeScript declaration files for multiple input files
 * @param files Array of input files
 * @param packageJsonContent Optional package.json content as string
 * @param options Options for declaration generation
 */
export async function generateMultiFileDeclarations(
  files: FileInput[],
  packageJsonContent?: string,
  options: GenerateOptions = {},
): Promise<DeclarationResult> {
  // Set default options
  const {
    filterToExports = true,
    resolveExternalDependencies = true,
    timeoutMs = 30000, // 30 second timeout
    maxMemoryMb = 256, // 256MB memory limit
    includeDeclarationMap = false,
  } = options;

  // Create a timeout promise to handle long-running compilations
  const timeoutPromise = new Promise<DeclarationResult>((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(`Declaration generation timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
  });

  // Start resource monitoring
  //  const startMemory = process.memoryUsage?.().heapUsed || 0;
  const startTime = Date.now();

  // Store warnings
  const warnings: string[] = [];

  // The actual declaration generation promise
  const generationPromise = (async () => {
    try {
      // Parse package.json if provided
      let packageJson: PackageJson | null = null;
      if (packageJsonContent) {
        try {
          packageJson = JSON.parse(packageJsonContent);
        } catch (e) {
          console.error("Failed to parse package.json:", e);
          warnings.push(`Failed to parse package.json: ${e.message}`);
        }
      } else {
        // Try to find package.json in the file map
        const packageJsonFile = files.find(
          (file) => file.name === "package.json",
        );
        if (packageJsonFile) {
          try {
            packageJson = JSON.parse(packageJsonFile.content);
          } catch (e) {
            console.error("Failed to parse package.json from file map:", e);
            warnings.push(
              `Failed to parse package.json from file map: ${e.message}`,
            );
          }
        }
      }

      // Configure compiler options for declaration generation
      const compilerOptions: ts.CompilerOptions = {
        declaration: true,
        emitDeclarationOnly: true,
        noEmitOnError: false,
        skipLibCheck: true,
        noResolve: false,
        noLib: true,
        skipDefaultLibCheck: true,
        suppressOutputPathCheck: true,

        // Don't be strict about types to avoid errors
        strict: false,
        noImplicitAny: false,
        strictNullChecks: false,
        strictFunctionTypes: false,
        strictBindCallApply: false,
        strictPropertyInitialization: false,
        noImplicitThis: false,
        alwaysStrict: false,

        // Target settings
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,

        // Path handling
        baseUrl: "/",
        rootDir: "/",

        // JSX support
        jsx: ts.JsxEmit.React,
        jsxFactory: "React.createElement",
        jsxFragmentFactory: "React.Fragment",

        // Declaration maps for source mapping
        declarationMap: includeDeclarationMap,

        // Incorporate compiler options from package.json if available
        ...(packageJson?.compilerOptions || {}),
      };

      // Create a virtual file system
      const fileMap = new Map<string, string>();

      // Add all input files to the file map
      const inputFileNames: string[] = [];
      files.forEach((file) => {
        fileMap.set(normalizePath(file.name), file.content);
        inputFileNames.push(normalizePath(file.name));
      });

      // Add enhanced lib.d.ts
      fileMap.set("lib.d.ts", getEnhancedLibDeclaration());

      // Add shims for external dependencies if needed
      if (resolveExternalDependencies && packageJson) {
        const externalDeps = getExternalDependencies(packageJson);
        const dependencyShims = createExternalDependencyShims(externalDeps);

        for (const [path, content] of Object.entries(dependencyShims)) {
          fileMap.set(path, content);
        }

        if (externalDeps.length > 0) {
          console.log(
            `Added type shims for ${externalDeps.length} external dependencies`,
          );
        }
      }

      // Store declaration files
      const declarationFiles: Record<string, string> = {};

      // Create a custom compiler host
      const compilerHost: ts.CompilerHost = {
        getSourceFile: (filename, languageVersion) => {
          const normalizedFilename = normalizePath(filename);
          const sourceText = fileMap.get(normalizedFilename);
          return sourceText !== undefined
            ? ts.createSourceFile(
                normalizedFilename,
                sourceText,
                languageVersion,
              )
            : undefined;
        },
        getDefaultLibFileName: () => "lib.d.ts",
        writeFile: (filename, content) => {
          // Only collect .d.ts and .d.ts.map files
          if (
            filename.endsWith(".d.ts") ||
            (includeDeclarationMap && filename.endsWith(".d.ts.map"))
          ) {
            // Keep original structure
            declarationFiles[filename] = content;
          }
        },
        getCurrentDirectory: () => "/",
        getCanonicalFileName: (fileName) => normalizePath(fileName),
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => "\n",
        fileExists: (filename) => fileMap.has(normalizePath(filename)),
        readFile: (filename) => fileMap.get(normalizePath(filename)) || "",
        directoryExists: (path) => true, // Always return true to handle nested paths
        getDirectories: () => [],
        realpath: (path) => path,
        resolveModuleNames: (moduleNames, containingFile) => {
          return moduleNames.map((moduleName) => {
            // If it's a relative import, try to resolve it
            if (moduleName.startsWith(".")) {
              const containingDir = containingFile
                .split("/")
                .slice(0, -1)
                .join("/");
              let resolvedPath = normalizePath(
                `${containingDir}/${moduleName}`,
              );

              // Try different extensions
              for (const ext of [".ts", ".tsx", ".d.ts", ""]) {
                const fullPath = resolvedPath.endsWith(ext)
                  ? resolvedPath
                  : `${resolvedPath}${ext}`;
                if (fileMap.has(fullPath)) {
                  return { resolvedFileName: fullPath };
                }
              }

              // Try with /index.ts
              const indexPath = `${resolvedPath}/index.ts`;
              if (fileMap.has(indexPath)) {
                return { resolvedFileName: indexPath };
              }
            }
            // For non-relative imports, check if we have a shim
            else if (resolveExternalDependencies) {
              const nodeModulePath = `node_modules/${moduleName}/index.d.ts`;
              if (fileMap.has(nodeModulePath)) {
                return { resolvedFileName: nodeModulePath };
              }
            }

            // If no match found
            return undefined;
          });
        },
      };

      // Create and run the program
      const program = ts.createProgram(
        inputFileNames,
        compilerOptions,
        compilerHost,
      );

      // Check memory usage
      //   const currentMemory = process.memoryUsage?.().heapUsed || 0;
      //   if (currentMemory - startMemory > maxMemoryMb * 1024 * 1024) {
      //     throw new Error(`Memory limit exceeded (${maxMemoryMb}MB)`);
      //   }

      // Emit declarations
      const emitResult = program.emit();

      // Collect diagnostics
      const allDiagnostics = ts
        .getPreEmitDiagnostics(program)
        .concat(emitResult.diagnostics);

      // Filter and format errors
      const errors = allDiagnostics
        .filter((d) => d.category === ts.DiagnosticCategory.Error)
        .map((diagnostic) => {
          if (diagnostic.file && diagnostic.start !== undefined) {
            const { line, character } =
              diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
            const message = ts.flattenDiagnosticMessageText(
              diagnostic.messageText,
              "\n",
            );
            return `${diagnostic.file.fileName}:${line + 1},${
              character + 1
            }: ${message}`;
          } else {
            return ts.flattenDiagnosticMessageText(
              diagnostic.messageText,
              "\n",
            );
          }
        });

      // Collect warnings (non-error diagnostics)
      const emitWarnings = allDiagnostics
        .filter((d) => d.category === ts.DiagnosticCategory.Warning)
        .map((diagnostic) => {
          if (diagnostic.file && diagnostic.start !== undefined) {
            const { line, character } =
              diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
            const message = ts.flattenDiagnosticMessageText(
              diagnostic.messageText,
              "\n",
            );
            return `${diagnostic.file.fileName}:${line + 1},${
              character + 1
            }: ${message}`;
          } else {
            return ts.flattenDiagnosticMessageText(
              diagnostic.messageText,
              "\n",
            );
          }
        });

      warnings.push(...emitWarnings);

      // Filter declarations based on package.json exports if requested and available
      const filteredDeclarations =
        filterToExports && packageJson
          ? filterRelevantDeclarations(declarationFiles, packageJson, program)
          : declarationFiles;

      // Calculate stats
      const endTime = Date.now();
      const processingTime = endTime - startTime;
      console.log(
        `Generated ${
          Object.keys(filteredDeclarations).length
        } declaration files in ${processingTime}ms`,
      );

      // Return the result
      return {
        files: filteredDeclarations,
        errors: errors,
        warnings: warnings,
        success:
          emitResult.emitSkipped === false &&
          Object.keys(filteredDeclarations).length > 0,
      };
    } catch (error) {
      console.error("Error during declaration generation:", error);
      return {
        files: {},
        errors: [`Internal error: ${error.message}`],
        warnings,
        success: false,
      };
    }
  })();

  // Race between generation and timeout
  return Promise.race([generationPromise, timeoutPromise]);
}

// Extended Cloudflare worker handler with more options
export default {
  async fetch(request: Request) {
    try {
      if (request.method === "POST") {
        const contentType = request.headers.get("content-type");

        if (contentType && contentType.includes("application/json")) {
          // Parse JSON body to get file data
          const data = await request.json();

          // Check if files array exists and is valid
          if (Array.isArray(data.files) && data.files.length > 0) {
            console.log(`Processing ${data.files.length} TypeScript files`);

            // Validate each file has name and content
            const files = data.files.map((file: any) => {
              if (!file.name || typeof file.content !== "string") {
                throw new Error(
                  "Each file must have a name and content string",
                );
              }
              return {
                name: file.name,
                content: file.content,
              };
            });

            // Extract package.json if it exists
            let packageJsonContent: string | undefined;
            const packageJsonFile = files.find(
              (file) => file.name === "package.json",
            );
            if (packageJsonFile) {
              packageJsonContent = packageJsonFile.content;
            } else if (data.packageJson) {
              // Also allow sending packageJson as a separate field
              packageJsonContent =
                typeof data.packageJson === "string"
                  ? data.packageJson
                  : JSON.stringify(data.packageJson);
            }

            // Build generation options
            const options: GenerateOptions = {
              filterToExports: data.filterToExports !== false,
              resolveExternalDependencies:
                data.resolveExternalDependencies !== false,
              timeoutMs: data.timeoutMs || 30000,
              maxMemoryMb: data.maxMemoryMb || 256,
              includeDeclarationMap: data.includeDeclarationMap === true,
            };

            // Generate declarations
            const result = await generateMultiFileDeclarations(
              files,
              packageJsonContent,
              options,
            );

            if (result.success) {
              return new Response(
                JSON.stringify(
                  {
                    success: true,
                    files: result.files,
                    warnings: result.warnings,
                    stats: {
                      fileCount: Object.keys(result.files).length,
                    },
                  },
                  null,
                  2,
                ),
                {
                  headers: { "Content-Type": "application/json" },
                },
              );
            } else {
              return new Response(
                JSON.stringify(
                  {
                    success: false,
                    errors: result.errors,
                    warnings: result.warnings,
                  },
                  null,
                  2,
                ),
                {
                  status: 400,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }
          } else {
            // No files provided, use example
            console.log("No files provided, using example files");
            const result = await generateMultiFileDeclarations(exampleFiles);

            return new Response(
              JSON.stringify(
                {
                  success: result.success,
                  note: "Used example files since no files were provided",
                  files: result.files,
                  warnings: result.warnings,
                },
                null,
                2,
              ),
              {
                headers: { "Content-Type": "application/json" },
              },
            );
          }
        } else {
          // Handle legacy single file format
          const sourceCode = await request.text();

          if (sourceCode.trim().length === 0) {
            throw new Error("Empty source code provided");
          }

          console.log(
            "Processing single TypeScript file, length:",
            sourceCode.length,
          );

          // Convert to multi-file format with single file
          const result = await generateMultiFileDeclarations([
            { name: "input.ts", content: sourceCode },
          ]);

          if (result.success) {
            // For backward compatibility, return just the declaration text for input.d.ts
            const declaration = result.files["input.d.ts"] || "";
            return new Response(declaration, {
              headers: { "Content-Type": "text/plain" },
            });
          } else {
            return new Response(
              JSON.stringify(
                {
                  errors: result.errors,
                  warnings: result.warnings,
                },
                null,
                2,
              ),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
        }
      } else {
        // GET request - show demo and API documentation
        const result = await generateMultiFileDeclarations(exampleFiles);

        return new Response(
          JSON.stringify(
            {
              message: "Enhanced TypeScript Declaration Generator API",
              usage: `POST TypeScript code as plain text, or JSON with a files array.
          
JSON API Options:
{
  "files": [
    { "name": "file.ts", "content": "// TypeScript code" },
    { "name": "package.json", "content": "// package.json content" }
  ],
  "filterToExports": true|false,  // Whether to filter declarations to only include types referenced by package exports
  "resolveExternalDependencies": true|false,  // Whether to generate shims for external dependencies
  "timeoutMs": 30000,  // Timeout in milliseconds (default: 30000)
  "maxMemoryMb": 256,  // Maximum memory usage in MB (default: 256)
  "includeDeclarationMap": false  // Whether to include declaration maps (default: false)
}

The API will automatically detect package.json in the files array to determine export entry points.
`,
              example: "Example output from demo files:",
              files: result.files,
              warnings: result.warnings,
            },
            null,
            2,
          ),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    } catch (error) {
      console.error("Error processing request:", error);
      return new Response(
        JSON.stringify(
          {
            error: error.message,
            stack: error.stack,
          },
          null,
          2,
        ),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },
};

// Example data for testing (unchanged)
const exampleFiles = [
  {
    name: "package.json",
    content: `{
      "name": "user-service-example",
      "version": "1.0.0",
      "main": "dist/index.js",
      "types": "dist/index.d.ts",
      "exports": {
        ".": {
          "import": "./dist/index.js",
          "require": "./dist/index.js",
          "types": "./dist/index.d.ts"
        },
        "./service": {
          "import": "./dist/service.js",
          "require": "./dist/service.js",
          "types": "./dist/service.d.ts"
        }
      }
    }`,
  },
  {
    name: "index.ts",
    content: `
      export * from './user';
      export * from './service';
      
      // This is the main entry point
      export const VERSION = '1.0.0';
    `,
  },
  {
    name: "user.ts",
    content: `
      export interface User {
        id: number;
        name: string;
        email?: string;
        role: Role;
      }
      
      export type Role = 'admin' | 'user' | 'guest';
    `,
  },
  {
    name: "service.ts",
    content: `
      import { User, Role } from './user';
      
      export class UserService {
        private users: User[] = [];
        
        addUser(name: string, role: Role): User {
          const user: User = {
            id: Math.floor(Math.random() * 1000),
            name,
            role
          };
          this.users.push(user);
          return user;
        }
        
        getUsers(): User[] {
          return [...this.users];
        }
      }
    `,
  },
  {
    name: "internal/utils.ts",
    content: `
      // This is an internal utility that shouldn't be included in public types
      export function generateId(): number {
        return Math.floor(Math.random() * 10000);
      }
      
      export interface Logger {
        log(message: string): void;
      }
    `,
  },
];
