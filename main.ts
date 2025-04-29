// Import TypeScript as an ES module (works in Workers)
import * as ts from "typescript";

export async function generateDeclarations(
  sourceCode: string,
  fileName: string = "input.ts",
) {
  // Create an in-memory compiler host
  const compilerHost = ts.createCompilerHost({});

  // Override the file system methods to work in-memory
  const fileMap = new Map<string, string>();
  fileMap.set(fileName, sourceCode);

  // Create virtual file system
  compilerHost.getSourceFile = (filename, languageVersion) => {
    const sourceText = fileMap.get(filename);
    return sourceText !== undefined
      ? ts.createSourceFile(filename, sourceText, languageVersion)
      : undefined;
  };

  compilerHost.writeFile = (filename, content) => {
    if (filename.endsWith(".d.ts")) {
      fileMap.set(filename, content);
    }
  };

  compilerHost.readFile = (filename) => fileMap.get(filename) || "";
  compilerHost.fileExists = (filename) => fileMap.has(filename);

  // Configure compiler options for declaration generation
  const compilerOptions: ts.CompilerOptions = {
    declaration: true,
    emitDeclarationOnly: true,
    noEmitOnError: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
  };

  // Create and run the program
  const program = ts.createProgram([fileName], compilerOptions, compilerHost);
  const emitResult = program.emit();

  // Check for errors
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .concat(emitResult.diagnostics);
  const errors = diagnostics.map((diagnostic) => {
    const { line, character } = diagnostic.file
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!)
      : { line: 0, character: 0 };
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      "\n",
    );
    return `${line + 1},${character + 1}: ${message}`;
  });

  // Get the declaration file
  const dtsFileName = fileName.replace(/\.tsx?$/, ".d.ts");
  const declarationFile = fileMap.get(dtsFileName);

  return {
    declaration: declarationFile || "",
    errors: errors,
    success: errors.length === 0,
  };
}

// Example usage in a Cloudflare Worker
export default {
  async fetch(request: Request) {
    try {
      // Get TypeScript code from request
      const sourceCode = await request.text();

      // Generate declaration
      const result = await generateDeclarations(sourceCode);

      if (result.success) {
        return new Response(result.declaration, {
          headers: { "Content-Type": "text/plain" },
        });
      } else {
        return new Response(JSON.stringify({ errors: result.errors }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    } catch (error) {
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  },
};
