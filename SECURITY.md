# Security policy

## Reporting a vulnerability

Please report security issues **privately**, not as a public issue.

Use GitHub's private vulnerability reporting: go to the **Security** tab of
this repository and choose *Report a vulnerability*. That channel is
authenticated, private to the maintainer, and keeps the whole exchange
attached to the repository.

You will get an acknowledgement, and credit in the release notes if you would
like it. This is a solo-maintained project, so please allow a reasonable
window for a response before disclosing publicly.

## What the threat model actually is

Worth being concrete, because "security" means something narrower here than in
most applications.

The browser build is a **single self-contained HTML file**. It makes no network
requests, has no backend, no accounts, no telemetry, and no external
dependencies of any kind. Circuits are loaded and saved as local files. Nothing
leaves the machine it runs on. Most classes of web vulnerability do not apply
because the surfaces they need do not exist.

The realistic concerns are:

- **Untrusted circuit files.** Loading a `.json` circuit or importing a `.raw`
  case from someone else runs that data through the parsers in `src/import.js`
  and the loader. A crash or a hang there is a bug worth reporting. Treat case
  files from strangers with the same caution as any other untrusted input.
- **The headless API and MCP server** (`api/`) run under Node with filesystem
  access, unlike the browser build. If you expose them beyond your own machine,
  that is a real trust boundary and you should treat it as one.
- **Dependency issues** in the `api/` runtime dependencies. The browser build
  vendors nothing, so it is unaffected.

## What is not a security issue

**A wrong number is not a security vulnerability, but it is a serious bug.**
Please report it as an ordinary issue with the circuit file and your reference
value. See [CONTRIBUTING.md](CONTRIBUTING.md).

OpenEMT is beta software and its results are not certified. Its accuracy
limitations are documented rather than hidden: see
[VALIDATION.md](VALIDATION.md) and SPEC.md section 7.
