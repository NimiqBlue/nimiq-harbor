# Third-party dependency notices

Harbor-owned code is MIT licensed; dependencies retain their original terms.
See THIRD_PARTY_LICENSES.txt for the upstream copyright, license and NOTICE texts.
This inventory includes every non-root package-lock entry, including optional
platform packages and development tools; it is not a browser bundle inventory.
No dependency source or binary is vendored by this source export.
When an archive supplies no standalone license file, its README license section
or package metadata declaration is retained explicitly, not invented. Platform
esbuild/rolldown packages additionally receive notices from their same-version
parent package. These are upstream evidence records, not a legal certification.

Regenerate with `python3 scripts/generate-license-notices.py`; verify with `--check`.
Generation needs network access to the public npm registry, not API credentials.

Lightning CSS and its platform packages are MPL-2.0, not MIT. They are unmodified
build-tool dependencies. Their source is available from https://github.com/parcel-bundler/lightningcss
(match the locked version). Preserve MPL terms/source availability if redistributing
those tools or modified covered files. npm platform archives may contain binaries,
not the preferred source form. Do not mistake archive availability for source availability.

The Fusion SDK omits a license field; its actual upstream LICENSE grants MIT terms.
No logo, font, trademark, API access or provider service rights are granted here.
A redistributed compiled application must also preserve applicable bundled notices.
These records do not replace a review after dependencies or distribution methods change.

| Locked path | Version | License | Scope |
| --- | --- | --- | --- |
| node_modules/@1inch/byte-utils | 3.1.9 | MIT | runtime |
| node_modules/@1inch/fusion-sdk | 2.4.16 | MIT (from upstream LICENSE; package metadata omits license) | runtime |
| node_modules/@1inch/limit-order-sdk | 5.4.3 | MIT | runtime |
| node_modules/@1inch/limit-order-sdk/node_modules/@1inch/byte-utils | 3.0.0 | MIT | runtime |
| node_modules/@adraffy/ens-normalize | 1.11.1 | MIT | runtime |
| node_modules/@cacheable/memory | 2.2.0 | MIT | development |
| node_modules/@cacheable/utils | 2.5.0 | MIT | development |
| node_modules/@esbuild/aix-ppc64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/android-arm | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/android-arm64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/android-x64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/darwin-arm64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/darwin-x64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/freebsd-arm64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/freebsd-x64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/linux-arm | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/linux-arm64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/linux-ia32 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/linux-loong64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/linux-mips64el | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/linux-ppc64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/linux-riscv64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/linux-s390x | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/linux-x64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/netbsd-arm64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/netbsd-x64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/openbsd-arm64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/openbsd-x64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/openharmony-arm64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/sunos-x64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/win32-arm64 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/win32-ia32 | 0.28.2 | MIT | development, optional |
| node_modules/@esbuild/win32-x64 | 0.28.2 | MIT | development, optional |
| node_modules/@eslint-community/eslint-utils | 4.10.1 | MIT | development |
| node_modules/@eslint-community/eslint-utils/node_modules/eslint-visitor-keys | 3.4.3 | Apache-2.0 | development |
| node_modules/@eslint-community/regexpp | 4.12.2 | MIT | development |
| node_modules/@eslint/config-array | 0.23.5 | Apache-2.0 | development |
| node_modules/@eslint/config-helpers | 0.7.0 | Apache-2.0 | development |
| node_modules/@eslint/core | 1.2.1 | Apache-2.0 | development |
| node_modules/@eslint/js | 10.0.1 | MIT | development |
| node_modules/@eslint/object-schema | 3.0.5 | Apache-2.0 | development |
| node_modules/@eslint/plugin-kit | 0.7.3 | Apache-2.0 | development |
| node_modules/@fastify/accept-negotiator | 2.1.1 | MIT | runtime |
| node_modules/@fastify/ajv-compiler | 4.0.7 | MIT | runtime |
| node_modules/@fastify/ajv-compiler/node_modules/ajv | 8.20.0 | MIT | runtime |
| node_modules/@fastify/ajv-compiler/node_modules/ajv/node_modules/fast-uri | 3.1.9 | BSD-3-Clause | runtime |
| node_modules/@fastify/ajv-compiler/node_modules/json-schema-traverse | 1.0.0 | MIT | runtime |
| node_modules/@fastify/deepmerge | 3.2.2 | MIT | runtime |
| node_modules/@fastify/error | 4.2.1 | MIT | runtime |
| node_modules/@fastify/fast-json-stringify-compiler | 5.1.1 | MIT | runtime |
| node_modules/@fastify/forwarded | 3.1.1 | MIT | runtime |
| node_modules/@fastify/merge-json-schemas | 0.2.2 | MIT | runtime |
| node_modules/@fastify/proxy-addr | 5.1.2 | MIT | runtime |
| node_modules/@fastify/send | 4.2.1 | MIT | runtime |
| node_modules/@fastify/static | 10.1.10 | MIT | runtime |
| node_modules/@humanfs/core | 0.19.2 | Apache-2.0 | development |
| node_modules/@humanfs/node | 0.16.8 | Apache-2.0 | development |
| node_modules/@humanfs/types | 0.15.0 | Apache-2.0 | development |
| node_modules/@humanwhocodes/module-importer | 1.0.1 | Apache-2.0 | development |
| node_modules/@humanwhocodes/retry | 0.4.3 | Apache-2.0 | development |
| node_modules/@isaacs/nonrecursive-glob-match | 1.1.0 | BlueOak-1.0.0 | runtime |
| node_modules/@jridgewell/resolve-uri | 3.1.2 | MIT | development |
| node_modules/@jridgewell/sourcemap-codec | 1.6.0 | MIT | development |
| node_modules/@jridgewell/trace-mapping | 0.3.31 | MIT | development |
| node_modules/@keyv/bigmap | 1.3.1 | MIT | development |
| node_modules/@keyv/serialize | 1.1.1 | MIT | development |
| node_modules/@lukeed/ms | 2.0.2 | MIT | runtime |
| node_modules/@noble/ciphers | 1.3.0 | MIT | runtime |
| node_modules/@noble/curves | 1.9.1 | MIT | runtime |
| node_modules/@noble/hashes | 1.8.0 | MIT | runtime |
| node_modules/@oxc-project/types | 0.154.0 | MIT | development |
| node_modules/@pinojs/redact | 0.4.0 | MIT | runtime |
| node_modules/@playwright/test | 1.64.1 | Apache-2.0 | development |
| node_modules/@rolldown/binding-android-arm-eabi | 1.2.14 | MIT | development, optional |
| node_modules/@rolldown/binding-android-arm64 | 1.2.14 | MIT | development, optional |
| node_modules/@rolldown/binding-darwin-arm64 | 1.2.14 | MIT | development, optional |
| node_modules/@rolldown/binding-darwin-x64 | 1.2.14 | MIT | development, optional |
| node_modules/@rolldown/binding-freebsd-x64 | 1.2.14 | MIT | development, optional |
| node_modules/@rolldown/binding-linux-arm-gnueabihf | 1.2.14 | MIT | development, optional |
| node_modules/@rolldown/binding-linux-arm64-gnu | 1.2.14 | MIT | development, optional |
| node_modules/@rolldown/binding-linux-arm64-musl | 1.2.14 | MIT | development, optional |
| node_modules/@rolldown/binding-linux-ppc64-gnu | 1.2.14 | MIT | development, optional |
| node_modules/@rolldown/binding-linux-s390x-gnu | 1.2.14 | MIT | development, optional |
| node_modules/@rolldown/binding-linux-x64-gnu | 1.2.14 | MIT | development, optional |
| node_modules/@rolldown/binding-linux-x64-musl | 1.2.14 | MIT | development, optional |
| node_modules/@rolldown/binding-openharmony-arm64 | 1.2.14 | MIT | development, optional |
| node_modules/@rolldown/binding-win32-arm64-msvc | 1.2.14 | MIT | development, optional |
| node_modules/@rolldown/binding-win32-x64-msvc | 1.2.14 | MIT | development, optional |
| node_modules/@rolldown/pluginutils | 1.0.1 | MIT | development |
| node_modules/@scure/base | 1.2.6 | MIT | runtime |
| node_modules/@scure/bip32 | 1.7.0 | MIT | runtime |
| node_modules/@scure/bip39 | 1.6.0 | MIT | runtime |
| node_modules/@types/chai | 5.2.3 | MIT | development |
| node_modules/@types/deep-eql | 4.0.2 | MIT | development |
| node_modules/@types/esrecurse | 4.3.1 | MIT | development |
| node_modules/@types/estree | 1.0.9 | MIT | development |
| node_modules/@types/json-schema | 7.0.15 | MIT | development |
| node_modules/@types/node | 26.6.5 | MIT | development |
| node_modules/@types/react | 19.3.0 | MIT | development |
| node_modules/@types/react-dom | 19.3.0 | MIT | development |
| node_modules/@typescript-eslint/eslint-plugin | 8.71.2 | MIT | development |
| node_modules/@typescript-eslint/eslint-plugin/node_modules/ignore | 7.0.12 | MIT | development |
| node_modules/@typescript-eslint/parser | 8.71.2 | MIT | development |
| node_modules/@typescript-eslint/project-service | 8.71.2 | MIT | development |
| node_modules/@typescript-eslint/scope-manager | 8.71.2 | MIT | development |
| node_modules/@typescript-eslint/tsconfig-utils | 8.71.2 | MIT | development |
| node_modules/@typescript-eslint/type-utils | 8.71.2 | MIT | development |
| node_modules/@typescript-eslint/types | 8.71.2 | MIT | development |
| node_modules/@typescript-eslint/typescript-estree | 8.71.2 | MIT | development |
| node_modules/@typescript-eslint/utils | 8.71.2 | MIT | development |
| node_modules/@typescript-eslint/visitor-keys | 8.71.2 | MIT | development |
| node_modules/@vitejs/plugin-react | 6.1.2 | MIT | development |
| node_modules/@vitest/mocker | 5.0.5 | MIT | development |
| node_modules/@vitest/spy | 5.0.5 | MIT | development |
| node_modules/abitype | 1.2.3 | MIT | runtime |
| node_modules/abstract-logging | 2.0.1 | MIT | runtime |
| node_modules/acorn | 8.19.0 | MIT | development |
| node_modules/acorn-jsx | 5.3.2 | MIT | development |
| node_modules/aes-js | 4.0.0-beta.5 | MIT | runtime |
| node_modules/agent-base | 6.0.2 | MIT | runtime |
| node_modules/ajv | 6.15.0 | MIT | development |
| node_modules/ajv-formats | 3.0.1 | MIT | runtime |
| node_modules/ajv-formats/node_modules/ajv | 8.20.0 | MIT | runtime |
| node_modules/ajv-formats/node_modules/fast-uri | 3.1.9 | BSD-3-Clause | runtime |
| node_modules/ajv-formats/node_modules/json-schema-traverse | 1.0.0 | MIT | runtime |
| node_modules/assert | 2.1.0 | MIT | runtime |
| node_modules/assertion-error | 2.0.1 | MIT | development |
| node_modules/asynckit | 0.4.0 | MIT | runtime |
| node_modules/atomic-sleep | 1.0.0 | MIT | runtime |
| node_modules/available-typed-arrays | 1.0.7 | MIT | runtime |
| node_modules/avvio | 9.3.1 | MIT | runtime |
| node_modules/axios | 1.20.0 | MIT | runtime |
| node_modules/balanced-match | 4.0.4 | MIT | runtime |
| node_modules/brace-expansion | 5.0.12 | MIT | runtime |
| node_modules/cacheable | 2.5.0 | MIT | development |
| node_modules/call-bind | 1.0.9 | MIT | runtime |
| node_modules/call-bind-apply-helpers | 1.0.2 | MIT | runtime |
| node_modules/call-bound | 1.0.4 | MIT | runtime |
| node_modules/chai | 6.3.0 | MIT | development |
| node_modules/combined-stream | 1.0.8 | MIT | runtime |
| node_modules/content-disposition | 3.0.0 | MIT | runtime |
| node_modules/cookie | 2.0.1 | MIT | runtime |
| node_modules/cross-spawn | 7.0.6 | MIT | development |
| node_modules/csstype | 3.2.3 | MIT | development |
| node_modules/debug | 4.4.3 | MIT | runtime |
| node_modules/deep-is | 0.1.4 | MIT | development |
| node_modules/define-data-property | 1.1.4 | MIT | runtime |
| node_modules/define-properties | 1.2.1 | MIT | runtime |
| node_modules/delayed-stream | 1.0.0 | MIT | runtime |
| node_modules/depd | 2.0.0 | MIT | runtime |
| node_modules/dequal | 2.0.3 | MIT | runtime |
| node_modules/detect-libc | 2.1.2 | Apache-2.0 | development |
| node_modules/dunder-proto | 1.0.1 | MIT | runtime |
| node_modules/es-define-property | 1.0.1 | MIT | runtime |
| node_modules/es-errors | 1.3.0 | MIT | runtime |
| node_modules/es-module-lexer | 2.3.2 | MIT | development |
| node_modules/es-object-atoms | 1.1.2 | MIT | runtime |
| node_modules/es-set-tostringtag | 2.1.0 | MIT | runtime |
| node_modules/esbuild | 0.28.2 | MIT | development |
| node_modules/escape-html | 1.0.3 | MIT | runtime |
| node_modules/escape-string-regexp | 4.0.0 | MIT | development |
| node_modules/eslint | 10.13.0 | MIT | development |
| node_modules/eslint-scope | 9.1.2 | BSD-2-Clause | development |
| node_modules/eslint-visitor-keys | 5.0.1 | Apache-2.0 | development |
| node_modules/espree | 11.2.0 | BSD-2-Clause | development |
| node_modules/esquery | 1.7.0 | BSD-3-Clause | development |
| node_modules/esrecurse | 4.3.0 | BSD-2-Clause | development |
| node_modules/estraverse | 5.3.0 | BSD-2-Clause | development |
| node_modules/estree-walker | 3.0.3 | MIT | development |
| node_modules/esutils | 2.0.3 | BSD-2-Clause | development |
| node_modules/ethers | 6.16.0 | MIT | runtime |
| node_modules/ethers/node_modules/@adraffy/ens-normalize | 1.10.1 | MIT | runtime |
| node_modules/ethers/node_modules/@noble/curves | 1.2.0 | MIT | runtime |
| node_modules/ethers/node_modules/@noble/hashes | 1.3.2 | MIT | runtime |
| node_modules/ethers/node_modules/@types/node | 22.7.5 | MIT | runtime |
| node_modules/ethers/node_modules/tslib | 2.7.0 | 0BSD | runtime |
| node_modules/ethers/node_modules/undici-types | 6.19.8 | MIT | runtime |
| node_modules/ethers/node_modules/ws | 8.22.0 | MIT | runtime |
| node_modules/eventemitter3 | 5.0.1 | MIT | runtime |
| node_modules/expect-type | 1.4.0 | Apache-2.0 | development |
| node_modules/fast-decode-uri-component | 1.0.1 | MIT | runtime |
| node_modules/fast-deep-equal | 3.1.3 | MIT | runtime |
| node_modules/fast-json-stable-stringify | 2.1.0 | MIT | development |
| node_modules/fast-json-stringify | 7.1.0 | MIT | runtime |
| node_modules/fast-json-stringify/node_modules/ajv | 8.20.0 | MIT | runtime |
| node_modules/fast-json-stringify/node_modules/ajv/node_modules/fast-uri | 3.1.9 | BSD-3-Clause | runtime |
| node_modules/fast-json-stringify/node_modules/json-schema-traverse | 1.0.0 | MIT | runtime |
| node_modules/fast-levenshtein | 2.0.6 | MIT | development |
| node_modules/fast-querystring | 1.1.2 | MIT | runtime |
| node_modules/fast-uri | 4.2.3 | BSD-3-Clause | runtime |
| node_modules/fastify | 5.12.7 | MIT | runtime |
| node_modules/fastify-plugin | 6.0.1 | MIT | runtime |
| node_modules/fastq | 1.20.3 | ISC | runtime |
| node_modules/fdir | 6.5.0 | MIT | development |
| node_modules/file-entry-cache | 11.1.5 | MIT | development |
| node_modules/find-my-way | 9.10.0 | MIT | runtime |
| node_modules/find-up | 5.0.0 | MIT | development |
| node_modules/flat-cache | 6.1.23 | MIT | development |
| node_modules/flatted | 3.4.4 | ISC | development |
| node_modules/follow-redirects | 1.16.2 | MIT | runtime |
| node_modules/for-each | 0.3.5 | MIT | runtime |
| node_modules/form-data | 4.0.6 | MIT | runtime |
| node_modules/fsevents | 2.3.3 | MIT | development, optional |
| node_modules/function-bind | 1.1.2 | MIT | runtime |
| node_modules/generator-function | 2.0.1 | MIT | runtime |
| node_modules/get-intrinsic | 1.3.0 | MIT | runtime |
| node_modules/get-proto | 1.0.1 | MIT | runtime |
| node_modules/glob | 14.0.3 | BlueOak-1.0.0 | runtime |
| node_modules/glob-parent | 6.0.2 | ISC | development |
| node_modules/glob/node_modules/minimatch | 11.0.4 | BlueOak-1.0.0 | runtime |
| node_modules/gopd | 1.2.0 | MIT | runtime |
| node_modules/has-property-descriptors | 1.0.2 | MIT | runtime |
| node_modules/has-symbols | 1.1.0 | MIT | runtime |
| node_modules/has-tostringtag | 1.0.2 | MIT | runtime |
| node_modules/hashery | 1.5.1 | MIT | development |
| node_modules/hasown | 2.0.4 | MIT | runtime |
| node_modules/hookified | 1.15.1 | MIT | development |
| node_modules/http-errors | 2.0.1 | MIT | runtime |
| node_modules/https-proxy-agent | 5.0.1 | MIT | runtime |
| node_modules/ignore | 5.3.2 | MIT | development |
| node_modules/imurmurhash | 0.1.4 | MIT | development |
| node_modules/inherits | 2.0.4 | ISC | runtime |
| node_modules/ipaddr.js | 2.5.0 | MIT | runtime |
| node_modules/is-arguments | 1.2.0 | MIT | runtime |
| node_modules/is-callable | 1.2.7 | MIT | runtime |
| node_modules/is-extglob | 2.1.1 | MIT | development |
| node_modules/is-generator-function | 1.1.2 | MIT | runtime |
| node_modules/is-glob | 4.0.3 | MIT | development |
| node_modules/is-nan | 1.3.2 | MIT | runtime |
| node_modules/is-regex | 1.2.1 | MIT | runtime |
| node_modules/is-typed-array | 1.1.15 | MIT | runtime |
| node_modules/isexe | 2.0.0 | ISC | development |
| node_modules/isows | 1.0.7 | MIT | runtime |
| node_modules/json-schema-ref-resolver | 3.0.1 | MIT | runtime |
| node_modules/json-schema-traverse | 0.4.1 | MIT | development |
| node_modules/json-stable-stringify-without-jsonify | 1.0.1 | MIT | development |
| node_modules/keyv | 5.6.0 | MIT | development |
| node_modules/levn | 0.4.1 | MIT | development |
| node_modules/light-my-request | 6.8.0 | BSD-3-Clause | runtime |
| node_modules/lightningcss | 1.33.0 | MPL-2.0 | development |
| node_modules/lightningcss-android-arm64 | 1.33.0 | MPL-2.0 | development, optional |
| node_modules/lightningcss-darwin-arm64 | 1.33.0 | MPL-2.0 | development, optional |
| node_modules/lightningcss-darwin-x64 | 1.33.0 | MPL-2.0 | development, optional |
| node_modules/lightningcss-freebsd-x64 | 1.33.0 | MPL-2.0 | development, optional |
| node_modules/lightningcss-linux-arm-gnueabihf | 1.33.0 | MPL-2.0 | development, optional |
| node_modules/lightningcss-linux-arm64-gnu | 1.33.0 | MPL-2.0 | development, optional |
| node_modules/lightningcss-linux-arm64-musl | 1.33.0 | MPL-2.0 | development, optional |
| node_modules/lightningcss-linux-x64-gnu | 1.33.0 | MPL-2.0 | development, optional |
| node_modules/lightningcss-linux-x64-musl | 1.33.0 | MPL-2.0 | development, optional |
| node_modules/lightningcss-win32-arm64-msvc | 1.33.0 | MPL-2.0 | development, optional |
| node_modules/lightningcss-win32-x64-msvc | 1.33.0 | MPL-2.0 | development, optional |
| node_modules/locate-path | 6.0.0 | MIT | development |
| node_modules/lru-cache | 11.5.3 | BlueOak-1.0.0 | runtime |
| node_modules/magic-string | 1.4.3 | MIT | development |
| node_modules/math-intrinsics | 1.1.0 | MIT | runtime |
| node_modules/mime | 3.0.0 | MIT | runtime |
| node_modules/mime-db | 1.52.0 | MIT | runtime |
| node_modules/mime-types | 2.1.35 | MIT | runtime |
| node_modules/minimatch | 10.2.6 | BlueOak-1.0.0 | development |
| node_modules/minipass | 7.1.3 | BlueOak-1.0.0 | runtime |
| node_modules/ms | 2.1.3 | MIT | runtime |
| node_modules/nanoid | 3.3.20 | MIT | development |
| node_modules/natural-compare | 1.4.0 | MIT | development |
| node_modules/object-is | 1.1.6 | MIT | runtime |
| node_modules/object-keys | 1.1.1 | MIT | runtime |
| node_modules/object.assign | 4.1.7 | MIT | runtime |
| node_modules/obug | 3.0.0 | MIT | development |
| node_modules/on-exit-leak-free | 2.1.2 | MIT | runtime |
| node_modules/optionator | 0.9.4 | MIT | development |
| node_modules/ox | 0.14.56 | MIT | runtime |
| node_modules/p-limit | 3.1.0 | MIT | development |
| node_modules/p-locate | 5.0.0 | MIT | development |
| node_modules/path-exists | 4.0.0 | MIT | development |
| node_modules/path-key | 3.1.1 | MIT | development |
| node_modules/path-scurry | 3.0.0 | BlueOak-1.0.0 | runtime |
| node_modules/picocolors | 1.1.1 | ISC | development |
| node_modules/picomatch | 4.0.7 | MIT | development |
| node_modules/pino | 10.4.0 | MIT | runtime |
| node_modules/pino-abstract-transport | 3.0.0 | MIT | runtime |
| node_modules/pino-std-serializers | 7.1.0 | MIT | runtime |
| node_modules/playwright | 1.64.1 | Apache-2.0 | development |
| node_modules/playwright-core | 1.64.1 | Apache-2.0 | development |
| node_modules/possible-typed-array-names | 1.1.0 | MIT | runtime |
| node_modules/postcss | 8.5.30 | MIT | development |
| node_modules/prelude-ls | 1.2.1 | MIT | development |
| node_modules/process-warning | 5.1.1 | MIT | runtime |
| node_modules/proxy-from-env | 2.1.0 | MIT | runtime |
| node_modules/punycode | 2.3.1 | MIT | development |
| node_modules/qified | 0.10.1 | MIT | development |
| node_modules/qified/node_modules/hookified | 2.2.0 | MIT | development |
| node_modules/quick-format-unescaped | 4.0.4 | MIT | runtime |
| node_modules/react | 19.3.1 | MIT | runtime |
| node_modules/react-dom | 19.3.1 | MIT | runtime |
| node_modules/real-require | 1.0.0 | MIT | runtime |
| node_modules/require-from-string | 2.0.2 | MIT | runtime |
| node_modules/ret | 0.5.0 | MIT | runtime |
| node_modules/reusify | 1.1.0 | MIT | runtime |
| node_modules/rfdc | 1.4.1 | MIT | runtime |
| node_modules/rolldown | 1.2.14 | MIT | development |
| node_modules/safe-regex-test | 1.1.0 | MIT | runtime |
| node_modules/safe-regex2 | 5.1.2 | MIT | runtime |
| node_modules/safe-stable-stringify | 2.5.0 | MIT | runtime |
| node_modules/scheduler | 0.28.0 | MIT | runtime |
| node_modules/secure-json-parse | 4.1.1 | BSD-3-Clause | runtime |
| node_modules/semver | 7.8.5 | ISC | runtime |
| node_modules/set-cookie-parser | 3.1.4 | MIT | runtime |
| node_modules/set-function-length | 1.2.2 | MIT | runtime |
| node_modules/setprototypeof | 1.2.0 | ISC | runtime |
| node_modules/shebang-command | 2.0.0 | MIT | development |
| node_modules/shebang-regex | 3.0.0 | MIT | development |
| node_modules/sonic-boom | 4.2.1 | MIT | runtime |
| node_modules/source-map-js | 1.2.2 | BSD-3-Clause | development |
| node_modules/split2 | 4.2.0 | ISC | runtime |
| node_modules/statuses | 2.0.2 | MIT | runtime |
| node_modules/std-env | 4.3.0 | MIT | development |
| node_modules/thread-stream | 4.2.0 | MIT | runtime |
| node_modules/tinybench | 6.2.2 | MIT | development |
| node_modules/tinyexec | 1.3.1 | MIT | development |
| node_modules/tinyglobby | 0.2.17 | MIT | development |
| node_modules/toad-cache | 3.7.4 | MIT | runtime |
| node_modules/toidentifier | 1.0.1 | MIT | runtime |
| node_modules/ts-api-utils | 2.5.0 | MIT | development |
| node_modules/tslib | 2.8.1 | 0BSD | runtime |
| node_modules/tsx | 4.23.15 | MIT | development |
| node_modules/type-check | 0.4.0 | MIT | development |
| node_modules/typescript | 6.0.3 | Apache-2.0 | runtime |
| node_modules/typescript-eslint | 8.71.2 | MIT | development |
| node_modules/undici-types | 8.9.0 | MIT | development |
| node_modules/uri-js | 4.4.1 | BSD-2-Clause | development |
| node_modules/util | 0.12.5 | MIT | runtime |
| node_modules/viem | 2.57.7 | MIT | runtime |
| node_modules/vite | 8.3.4 | MIT | development |
| node_modules/vitest | 5.0.5 | MIT | development |
| node_modules/which | 2.0.2 | ISC | development |
| node_modules/which-typed-array | 1.1.24 | MIT | runtime |
| node_modules/why-is-node-running | 3.2.1 | MIT | development |
| node_modules/word-wrap | 1.2.5 | MIT | development |
| node_modules/ws | 8.21.0 | MIT | runtime |
| node_modules/yocto-queue | 0.1.0 | MIT | development |
| node_modules/zod | 4.6.7 | MIT | runtime |
