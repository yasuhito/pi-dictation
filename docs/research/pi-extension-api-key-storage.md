# Pi extension API-key storage research

This report is a point-in-time inspection using only Pi's official documentation/package gallery and the repositories, READMEs, and source code of the packages discussed.

## Executive conclusion

Keep `openaiApiKeyCommand`. Command-based retrieval is a Pi-native credential pattern and is also used by major extensions, so the option is not an unusual Pi Dictation invention. Reframe the README examples, however: `OPENAI_API_KEY` should remain the simplest portable setup; the macOS Keychain recipe is a good secure-storage option; and Linux `secret-tool` should be described as an **optional desktop Secret Service recipe**, not as “the system keyring” or a universal Linux standard. Secret Service needs a running, unlocked session keyring and D-Bus session and is commonly unavailable on headless/SSH hosts.

Pi's own `auth.json` is relevant precedent but is not currently Pi Dictation's credential source. Pi provider credentials authenticate model-provider calls made through Pi; Pi Dictation independently calls an OpenAI-compatible audio-transcription endpoint and resolves its own package-specific key. Documentation should make that distinction explicit rather than imply `/login` configures dictation.

## Scope and popularity evidence

The representative set was selected for credential relevance, with popularity taken only from the official Pi package gallery:

| Package | Gallery evidence at inspection | Why inspected |
| --- | ---: | --- |
| [`pi-mcp-adapter`](https://pi.dev/packages/pi-mcp-adapter) | 354.4K downloads/month, 151.6K/week | Very widely downloaded extension with OS credential-store and Linux/headless behavior |
| [`pi-web-access`](https://pi.dev/packages/pi-web-access) | 222K downloads/month, 75.6K/week | Very widely downloaded extension with OpenAI and many extension-specific API keys |
| [`pi-voice-input`](https://pi.dev/packages/pi-voice-input) | 1,446 downloads/month, 77/week | Popular directly relevant voice-input extension with an extension-specific ASR key |
| [`@codexstar/pi-listen`](https://pi.dev/packages/@codexstar/pi-listen) | 558 downloads/month, 203/week | Directly relevant voice/STT extension with cloud and local backends |
| [`pi-keyrouter`](https://pi.dev/packages/pi-keyrouter) | 1,195 downloads/month, 38/week | Credential-focused extension illustrating plaintext multi-key configuration and Pi runtime overrides |

The gallery figures are a point-in-time display and can change. They support only relative statements such as “the gallery displayed high download counts”; they do not establish active-user counts or security quality.

## Pi core/provider credentials versus extension-specific credentials

### Pi core/provider handling

Pi's provider documentation supports four practical inputs:

1. `/login` stores an API key or OAuth credential in `~/.pi/agent/auth.json`.
2. Known provider environment variables, including `OPENAI_API_KEY`.
3. A runtime `--api-key` override.
4. Config-value resolution in `auth.json`/custom provider configuration, including `$ENV_VAR`, literal values, and `!command` output.

The documented resolution order is runtime override, `auth.json`, environment, then custom-provider configuration. Pi creates its auth file with mode `0600`. Pi's own command examples include macOS `security find-generic-password` and 1Password `op read`, demonstrating that command retrieval is an intentional first-class pattern rather than a workaround. [Pi provider documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md)

The implementation matches the documentation: `AuthStorage` reads and persists provider-scoped API-key/OAuth records and resolves stored credentials before environment fallback. [`packages/coding-agent/src/core/auth-storage.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/auth-storage.ts) Command resolution is cached for the Pi process lifetime. [`packages/coding-agent/src/core/resolve-config-value.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/resolve-config-value.ts)

These are **model-provider** credentials. An extension can deliberately register a provider and participate in this machinery, but arbitrary extension services do not automatically inherit it. Pi's extension/provider API explicitly allows `$ENV_VAR`, literal, or `!command` provider keys. [Pi custom-provider documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md)

### Pi Dictation handling

Pi Dictation does not register an OpenAI model provider or ask `ctx.modelRegistry` for provider authentication. It resolves, in order, the conventional `OPENAI_API_KEY`, a literal package-config value, and then (when no literal is resolved) its `openaiApiKeyCommand`; it sends the key itself to `/audio/transcriptions`. See [`extensions/config.ts`](../../extensions/config.ts) and [`extensions/pi-dictation.ts`](../../extensions/pi-dictation.ts).

Consequences:

- `/login openai` and Pi's OpenAI/ChatGPT provider auth should **not** be documented as Pi Dictation setup today.
- `~/.pi/agent/auth.json` should not be presented as Pi Dictation's canonical key file merely because both use OpenAI.
- A ChatGPT/Codex subscription credential is not equivalent documentation evidence for OpenAI API audio-transcription entitlement.
- Pi Dictation's `openaiApiKeyCommand` is valuable because it lets the extension retrieve a service-specific API key from an external secret manager without placing that key in `pi-dictation.json`.

## Representative extension findings

### 1. `pi-web-access`: environment, plaintext config, commands, and selective Pi-auth reuse

The gallery's highly downloaded `pi-web-access` accepts extension-specific keys in `~/.pi/web-search.json`, including an `openaiApiKey`, and also accepts explicit `$NAME`/`${NAME}` environment references and `!command` sources. Its README says ordinary provider environment variables retain precedence over literal config values. It can additionally use Pi Codex `/login` auth for its OpenAI search path, an explicit integration implemented by that extension rather than a universal extension behavior. [`nicobailon/pi-web-access` README](https://github.com/nicobailon/pi-web-access)

This is the closest high-popularity precedent for Pi Dictation's shape: extension-specific config plus environment and command retrieval. It also shows that reusing Pi auth requires conscious extension logic and service compatibility.

### 2. `pi-mcp-adapter`: native OS credential store, including Secret Service/libsecret

The gallery's highly downloaded `pi-mcp-adapter` stores persistent OAuth credentials in the operating-system credential store, keyed to the configured server and bound to its URL. It treats old plaintext token directories as import-only legacy storage and fails closed rather than silently falling back to plaintext when secure storage is unavailable. On headless Linux, its README says persistent OAuth usually requires an unlocked Secret Service/libsecret keyring. [`nicobailon/pi-mcp-adapter` README](https://github.com/nicobailon/pi-mcp-adapter)

This is strong evidence that Linux Secret Service is an appropriate secure option in the Pi ecosystem. It is not evidence that `secret-tool` is universally available or that every Linux environment has a usable keyring. Indeed, the extension's explicit headless caveat argues for conditional wording.

### 3. `pi-voice-input`: extension-owned plaintext config

The directly relevant voice extension stores a VolcEngine ASR key locally in `~/.pi/agent/voice-input.config.json`, entered using `/voice key`; its status/config UI avoids printing the value. [`tr-nc/pi-voice-input` README](https://github.com/tr-nc/pi-voice-input)

This demonstrates that extension-specific transcription credentials are commonly kept separate from Pi provider auth, but it is weaker protection than a keyring or command reference because the secret remains plaintext on disk.

### 4. `@codexstar/pi-listen`: environment and explicit persistence

The directly relevant voice/STT package documents `DEEPGRAM_API_KEY` as its normal cloud credential. Its README says a shell-provided key is used at runtime and is not copied into Pi settings; if the user explicitly pastes a key during onboarding, it is saved to `~/.env.secrets` or shell configuration. [`codexstar69/pi-listen` README](https://github.com/codexstar69/pi-listen)

This supports environment variables as the familiar portable default, but saving secrets in shell startup files or `.env`-style files is plaintext persistence and should not be labeled secure storage.

### 5. `pi-keyrouter`: plaintext config plus Pi runtime override

`pi-keyrouter` stores arrays of provider keys in plaintext `~/.pi/keyrouter.json`, warns that they are plaintext, and injects the active key using Pi's non-persistent runtime auth override. Its gallery page explicitly describes both behaviors. [`pi-keyrouter` gallery/README rendering](https://pi.dev/packages/pi-keyrouter)

This is useful contrast: Pi runtime overrides prevent Pi itself from persisting the injected value, but they do not secure the extension's source file. “Uses Pi native auth” and “secure at rest” are separate properties.

## Method comparison

| Method | Observed in primary sources | At-rest/security properties | Portability and operational notes | Recommendation for Pi Dictation docs |
| --- | --- | --- | --- | --- |
| Environment variable | Pi core; `pi-web-access`; `pi-listen` | Not written by Pi Dictation, but may be plaintext in shell config and is inherited by child processes | Broadest and simplest; suitable for CI/headless systems | Keep as the first/default setup, but do not call shell-profile storage secure |
| Pi `auth.json` | Pi core and provider extensions | Plain JSON protected by `0600`; supports literal, env interpolation, or command references | Native for model providers and registered providers; not automatically available to unrelated extension calls | Explain it is separate and not currently used by Dictation; do not recommend manual duplication there |
| Plaintext extension config | `pi-web-access`, `pi-voice-input`, `pi-keyrouter` | Secret directly readable by the account and backups; file mode can reduce exposure but does not encrypt | Easy, extension-local, often used in practice | Keep `openaiApiKey` supported but label it fallback/less preferred |
| Command retrieval | Pi core; `pi-web-access`; Pi Dictation | Config stores a command/reference, not the key; key appears in process memory/stdout at retrieval | Works with Keychain, Secret Service, 1Password, `pass`, Vault CLIs, etc.; depends on command availability/session state | Keep and present as the advanced secure-store integration point |
| Linux Secret Service/libsecret | `pi-mcp-adapter`; Pi Dictation's current `secret-tool` recipe | Encrypted/keyring-backed according to desktop keyring implementation; unlocked-session access is required | Common on GNOME/KDE desktops, but not universal; D-Bus/keyring availability is problematic on headless/SSH hosts | Keep recipe, but label “optional, for Linux desktops with an unlocked Secret Service keyring”; mention `secret-tool`/service prerequisites and offer env/other command managers for headless hosts |
| macOS Keychain | Pi core command example; Pi Dictation; other extensions such as Pi MCP's OS store | Native per-user credential store; command emits the secret only at retrieval | `security` is built into macOS; access-control prompts/locked keychains can still fail | Keep as recommended macOS secure-storage recipe |

## Is `secret-tool` standard or appropriate?

**Appropriate: yes. Standard/universal: no.**

Secret Service is the conventional cross-desktop Linux credential-store interface, and a top-downloaded Pi extension relies on Secret Service/libsecret for persistent secure credentials on Linux. `secret-tool` is a reasonable CLI bridge for Pi Dictation's command resolver. However:

- `secret-tool` is a libsecret utility, not a guaranteed base Linux command.
- Installing the CLI alone does not create an unlocked keyring or a D-Bus user session.
- Minimal servers, containers, CI jobs, SSH-only sessions, and some long-lived `tmux` environments commonly lack usable Secret Service state.
- Pi's own provider documentation demonstrates generic `!command`, macOS Keychain, and 1Password, but does not designate `secret-tool` as the canonical Linux credential mechanism.

Therefore the README should avoid the unconditional phrase “save the key in the system keyring” before presenting Linux instructions. Prefer wording such as:

> For stronger at-rest protection, `openaiApiKeyCommand` can retrieve the key from a credential manager. On macOS, use Keychain. On a Linux desktop with a running, unlocked Secret Service keyring, `secret-tool` is one option. Headless/SSH systems often do not have Secret Service; use an injected environment variable or another non-interactive secret-manager command there.

## README.md and README.ja.md recommendation

### Required documentation changes

1. **Keep the initial `export OPENAI_API_KEY=...` example.** Call it the simplest portable method, not necessarily secure persistence. Keep the warning that the variable must exist before Pi starts.
2. **Keep `openaiApiKeyCommand` and both current command examples.** This interface aligns with Pi core and major extension practice.
3. **Reframe the section title/lead.** Replace the claim that these recipes use “the system keyring” generically with “Retrieve the key from a credential manager (optional).” Introduce platform qualifications.
4. **Qualify Linux Secret Service.** State that the example requires `secret-tool` plus a running and unlocked Secret Service keyring in the same user session. State that it may not work on headless/SSH hosts. Do not provide distro installation commands unless they are separately verified against the supported distributions; package names differ.
5. **Keep macOS Keychain as the preferred macOS secure example.** The current `security add-generic-password ... -w` and lookup command are consistent with Pi's own command-retrieval documentation.
6. **Add a Pi-auth distinction note.** Suggested English text:

   > Pi Dictation's transcription credential is separate from Pi's model-provider login. Running `/login` or having an OpenAI/ChatGPT model available does not configure the audio-transcription request; set `OPENAI_API_KEY` or `openaiApiKeyCommand`.

   Suggested Japanese text:

   > Pi Dictationの文字起こし用認証情報は、Piのモデルプロバイダー用ログインとは別です。`/login` を実行したことやOpenAI/ChatGPTモデルを利用できることだけでは、音声文字起こしリクエストは設定されません。`OPENAI_API_KEY` または `openaiApiKeyCommand` を設定してください。

7. **Describe literal `openaiApiKey` accurately.** It remains supported and the config file is saved with `0600`, but it is plaintext; recommend environment injection or credential-manager commands for stronger at-rest protection.
8. **Keep both translations semantically aligned.** Commands, caveats, credential precedence, and the Pi-auth distinction should match in `README.md` and `README.ja.md`.

### Suggested ordering

1. Portable environment-variable setup.
2. Clear Pi-auth-versus-Dictation note.
3. Optional credential-manager retrieval:
   - macOS Keychain;
   - Linux desktop Secret Service (`secret-tool`) with prerequisites/caveat;
   - generic note that any trusted command printing only the key can be used.
4. Plaintext `openaiApiKey` only as an explicitly less-preferred fallback.

## Review findings at the time of research

The README findings below were resolved in the subsequent documentation update.

- **Medium — `README.md` and `README.ja.md`, “Configure OpenAI transcription” lead:** “the system keyring” overstates Linux availability. Secret Service is appropriate but conditional, especially on remote/headless Linux. Reframe and add prerequisites/caveat.
- **Medium — `README.md` and `README.ja.md`, OpenAI setup:** the docs do not explicitly distinguish Pi provider `/login` credentials from Pi Dictation's extension-specific transcription key. Users may reasonably assume Pi's OpenAI login is reused. Add the distinction note.
- **Low — `README.md` and `README.ja.md`, configuration table:** `openaiApiKey` is described as less preferred but not explicitly as plaintext. Say so.
- **No blocker — `openaiApiKeyCommand`:** retaining it is well supported by Pi core and representative extensions. The macOS and Linux commands themselves do not need removal.

## Sources inspected

### Kept

- [Pi provider documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md) — authoritative auth storage, environment, command syntax, permissions, and precedence.
- [Pi `AuthStorage` source](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/auth-storage.ts) — authoritative credential resolution/persistence implementation.
- [Pi config-value resolver source](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/resolve-config-value.ts) — authoritative `!command` execution/caching behavior.
- [Pi custom-provider documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md) — authoritative extension/provider key integration.
- [Pi package gallery](https://pi.dev/packages) and the individual package pages linked in the scope table — official popularity and package metadata evidence.
- [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access) — extension-specific env/plaintext/command keys and explicit Pi Codex auth integration.
- [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) — OS credential store and Linux Secret Service/headless caveat.
- [`tr-nc/pi-voice-input`](https://github.com/tr-nc/pi-voice-input) — relevant voice extension's extension-owned key storage.
- [`codexstar69/pi-listen`](https://github.com/codexstar69/pi-listen) — relevant voice extension's environment and explicit persistence behavior.
- [`pi-keyrouter` gallery page](https://pi.dev/packages/pi-keyrouter) — gallery-rendered upstream README details on plaintext keys and Pi runtime overrides.
- Local Pi Dictation source: [`extensions/config.ts`](../../extensions/config.ts), [`extensions/pi-dictation.ts`](../../extensions/pi-dictation.ts), [`README.md`](../../README.md), and [`README.ja.md`](../../README.ja.md) — current behavior and wording under review.

### Dropped or not used as evidence

- Search-engine summaries, third-party blog posts, Stack Overflow answers, and general Linux keyring tutorials — excluded because the task requires primary sources.
- GitHub issues about unrelated coding agents/keychain implementations — excluded because they are not Pi package implementations or official Pi documentation.
- Gallery packages with no API key or no relevant credential behavior — excluded as non-responsive.
- Packages whose gallery pages had no download count — not used to make popularity claims.

## Limitations and residual risks

- Gallery download numbers are mutable npm-derived snapshots and may include automation; they are not active-install or trust metrics.
- The sample is representative, not exhaustive. The gallery contains many packages and fast-moving forks.
- Repository default branches can change after this report; URLs are branch links rather than commit-pinned archival citations.
- No live Linux desktop/headless Secret Service experiment was performed. The recommendation is based on the inspected Pi extension's documented operational boundary and Pi's supported command mechanism.
- This report recommends documentation changes only. Reusing Pi's provider auth for transcription would be a product/code change requiring explicit handling of API-key versus subscription/OAuth credential compatibility and should not be implied by README edits.
