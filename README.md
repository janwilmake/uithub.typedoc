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

Revelation:

1. The `typescript` package works in a cloudflare worker and is very well understood by claude
2. To get good docs we'd need:
   1. find docs files and/or README in the package or repo. This is supplemental but useful
   2. The entrypoint is defined in `package.json`. npm does not always have the `.ts` so we need to find the belonging github repo first. Good packages have this defined in their `package.json` e.g. https://www.npmjs.com/package/typedoc-plugin-markdown?activeTab=code leads to https://github.com/typedoc2md/typedoc-plugin-markdown/tree/main/packages/typedoc-plugin-markdown and there the `tsconfig.json` can be found with the to be included typescript files. if supported, via releases we can find the sha of the original code at a given version.
   3. Once we have the src typescript code, we can create the `.d.ts` ourselves in our own way (or any other inferences based on the original source code).

Other strategies we can consider:

1. look for .d.ts in the npm package, usually exists. Use @types/{package} if it doesn't, that is often a fallback. As a last resort, just get the raw code. This'd be a great simplistic way.
2. `isReadmeSufficient` could determine whether or not the README is sufficient to use the package. The NPM package always has the README ans oftentimes the README is quote good already in itself to determine usage.

All in all, there are many ways and many edgecases. To get somewhere, it's best to first start with the basics:

1. create `ingesttar` and npmjs domain binding to `uithub`
2. get `npmjz` module resolution as I had before with function to also get all versions based on lockfile and/or package.json
3. ensure the above allows only finding packages that are specified, not subdependencies
4. create a merger that outputs `FormData` for an applied filter on every package found in package json (not their dependencies)
5. this merger is ideal to only just get (1) the README-file for each and (2) package.json of each.

Let's try this approach first. Let's do this in `packagedocs` lib
