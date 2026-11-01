# @gxaditya/vamp

One-name install for [Vamp](https://github.com/GxAditya/vamp) — a fully local,
headless music engine for coding agents.

```sh
npm i -g @gxaditya/vamp
vamp --version      # CLI
vamp-mcp            # stdio MCP server
```

Or without installing:

```sh
npx -p @gxaditya/vamp vamp --version
npx -p @gxaditya/vamp vamp-mcp --project-root ~/vamp-projects
```

The library entry re-exports `@gxaditya/vamp-sdk` plus the `schema`, `engine`,
and `project` namespaces. Use the individual `@gxaditya/vamp-*` packages when
you want a smaller dependency footprint.

License: AGPL-3.0-only — see LICENSE.
