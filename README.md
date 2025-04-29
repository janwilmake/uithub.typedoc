# Generate Typedoc

This will need to be done on vercel and can be done when filtering on ts(x) and then finding the common basepath:

https://www.npmjs.com/package/typedoc
https://www.npmjs.com/package/typedoc-plugin-markdown

This will provide super accurate docs for all functions in a short format, and it's pretty much free to do.

1. typedoc-zipobject.vercel.app using zipobject.vercel.app
2. make available in context.forgithub.com

TODO

- ✅ clone https://github.com/duckdb/duckdb-wasm
- ✅ list entrypoints (https://uuithub.com/duckdb/duckdb-wasm?pathPatterns=**%2Fpackage.json&accept=text%2Fmarkdown)
- ✅ See typedoc result manually

What I need to host this:

- Vercel: Max 512MB
- Typedoc needs node_modules installed which is often larger than 512MB.

Comparison:

- All src: https://uithub.com/duckdb/duckdb-wasm/tree/main/packages/duckdb-wasm/src?accept=text%2Fhtml&maxTokens=10000000&lines=false (47k tokens)
- Markdown typedoc of that: https://uithub.com/janwilmake/duckdb-wasm-docs?accept=text%2Fhtml&maxTokens=10000000&lines=false (54k tokens)

Strangely enough, typedefs in md are larger. not useful!

Attempt 2: Use tsc directly to output a giant `.d.ts` file https://claude.ai/share/0ca268ed-5d95-4c14-8e3c-86a99ff84955. This will likely generate a smaller file, and it can potentially even be made smaller. There may be ways out of `tsc` to generate a `.d.ts` file.
