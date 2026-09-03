# Artizo - local development and release automation
# =================================================
#
# ── Boundary ───────────────────────────────────────────────────
# package.json scripts = atomic, single-tool commands (tsc, vitest, esbuild, knip)
# Makefile              = orchestration (pipelines, release, cleanup, setup)
#
# Always prefer npm scripts directly during development:
#   npm test              Fast feedback (unit + property, no Docker)
#   npm run test:coverage Coverage report (unit + property)
#   make coverage         Coverage + saved report + overall summary line
#   npm run test:all      Everything (unit + property + integration)
#   npm run lint          Type-check + dead-code detection
#   npm run build         esbuild bundle only (no VSIX)
#   npm run package:kiro  Build a single VSIX for Kiro
#
# Makefile targets:
#   make setup            Explicit one-time setup (also runs automatically when needed)
#   make check            Full quality gate (lint + test:all)
#   make build            esbuild bundle only (no VSIX)
#   make package          Build all platform VSIX files
#   make package-kiro     Build a single VSIX for Kiro
#   make release VERSION=x.y.z   Bump version, check, package, tag
#   make publish          Publish all VSIX files to Open VSX
#   make docs            Regenerate vendor README templates from README.md
#   make vscodium-versions  Refresh bundled VSCodium release list
#   make sync-shared     Copy shared files from ../zygos
#   make clean            Remove build artifacts (safe, no re-setup needed)
#   make distclean        Nuclear clean (auto-recovers on next make)
#
# Make uses sentinel files to auto-resolve dependencies:
#   node_modules/.package-lock.json                  tracks root npm install
#   vendor/devcontainers-cli/.git                     tracks the vendored submodule checkout
#   vendor/devcontainers-cli/node_modules/.package-lock.json  tracks vendored CLI dep install
# If any is missing or out-of-date, Make rebuilds it automatically.
#
# Publishing requires:
#   OVSX_PAT environment variable (Personal Access Token from open-vsx.org)
#   Publisher namespace claimed on Open VSX (one-time setup)

.PHONY: setup check lint typecheck test test-all test-coverage coverage build package package-kiro package-trae package-devin package-vscodium release publish clean distclean sync-shared docs vscodium-versions

# ── Sentinel files ─────────────────────────────────────────────

NODE_MODULES := node_modules/.package-lock.json
VENDOR_CLI   := vendor/devcontainers-cli/src/spec-node/devContainers.ts
VENDOR_NM    := vendor/devcontainers-cli/node_modules/.package-lock.json

# Files synced 1:1 from ../zygos. Edit these in zygos, then run
# `make sync-shared` to copy them into this tree. Do NOT edit the
# artizo copies directly - the next sync overwrites them. The list
# lives here (not in AGENTS.md) so it stays in sync with the build.
#
# Format: <zygos-relative-path>:<artizo-relative-path>
SHARED_FROM_ZYGOS := \
  src/platform/downloadTypes.ts:src/platform/downloadTypes.ts \
  src/platform/forkTemplates.ts:src/platform/forkTemplates.ts \
  src/platform/mergeConfig.ts:src/platform/mergeConfig.ts \
  src/remote/url.ts:src/remote/url.ts \
  src/remote/checksum.ts:src/remote/checksum.ts \
  src/remote/vscodiumFeed.ts:src/remote/vscodiumFeed.ts \
  src/remote/download.ts:src/remote/download.ts \
  src/remote/folderHistory.ts:src/remote/folderHistory.ts \
  src/ssh/askpassCache.ts:src/ssh/askpassCache.ts \
  src/ssh/askpassServer.ts:src/ssh/askpassServer.ts \
  src/common/temp.ts:src/common/temp.ts \
  src/webviews/serverDownloadPanel.ts:src/webviews/serverDownloadPanel.ts \
  resources/serverDownload/app.js:resources/serverDownload/app.js \
  resources/serverDownload/index.html:resources/serverDownload/index.html \
  resources/serverDownload/styles.css:resources/serverDownload/styles.css \
  scripts/askpass/askpass.sh:scripts/askpass/askpass.sh \
  scripts/askpass/askpass.cmd:scripts/askpass/askpass.cmd \
  scripts/askpass/askpass-main.js:scripts/askpass/askpass-main.js \
  vendor/node-dirty/dirty.d.ts:vendor/node-dirty/dirty.d.ts \
  scripts/download-vscodium-versions.mjs:scripts/download-vscodium-versions.mjs \
  test/unit/checksum.test.ts:test/unit/checksum.test.ts \
  test/unit/download.test.ts:test/unit/download.test.ts \
  test/unit/url.test.ts:test/unit/url.test.ts \
  test/unit/folderHistory.test.ts:test/unit/folderHistory.test.ts \
  test/unit/vscodiumFeed.test.ts:test/unit/vscodiumFeed.test.ts \
  test/unit/askpassCache.test.ts:test/unit/askpassCache.test.ts \
  test/unit/askpass.test.ts:test/unit/askpass.test.ts \
  test/unit/temp.test.ts:test/unit/temp.test.ts \
  test/unit/temp.retry.test.ts:test/unit/temp.retry.test.ts \
  test/unit/forkTemplates.test.ts:test/unit/forkTemplates.test.ts \
  test/unit/mergeConfig.test.ts:test/unit/mergeConfig.test.ts

# Change this to update the vendored CLI. make does the rest.
VENDOR_CLI_VERSION := v0.87.0

# ── Auto-setup (Make resolves these via file timestamps) ───────

$(NODE_MODULES): package.json package-lock.json
	npm install

$(VENDOR_CLI):
	@actual=$$(git -C vendor/devcontainers-cli describe --tags --exact-match 2>/dev/null); \
	if [ "$$actual" != "$(VENDOR_CLI_VERSION)" ]; then \
		echo "Switching vendor CLI: $$actual -> $(VENDOR_CLI_VERSION)"; \
		git -C vendor/devcontainers-cli fetch --tags --quiet; \
		git -C vendor/devcontainers-cli checkout -f $(VENDOR_CLI_VERSION) --quiet; \
		rm -rf vendor/devcontainers-cli/node_modules vendor/devcontainers-cli/dist; \
	fi

# Install the vendored CLI's npm deps so esbuild can resolve imports
# like `tar`, `proxy-agent`, `ncp`, `shell-quote` when bundling the CLI
# source directly (no separate compile step). Re-runs after distclean
# or a version switch removes node_modules.
$(VENDOR_NM): $(VENDOR_CLI)
	cd vendor/devcontainers-cli && npm install --ignore-scripts && rm -f package-lock.json

# ── Explicit setup (convenience, equivalent to the chain above) ─

setup: $(VENDOR_CLI)

# ── Quality gates ──────────────────────────────────────────────

check: $(NODE_MODULES) $(VENDOR_CLI) $(VENDOR_NM) check-shared-drift docs lint test-all
	@echo "=== All checks passed ==="

lint:
	npm run lint

typecheck:
	npm run typecheck

test:
	npm test

test-all:
	npm run test:all

test-coverage:
	npm run test:coverage

# Coverage, one run, answer at the end: full text report saved to
# coverage-run.log (project root; the reporter wipes coverage/ mid-run,
# so the log lives outside it), HTML in coverage/index.html, and the
# overall src-only summary (vendor excluded via vitest.config.ts)
# printed last so you don't have to scroll.
coverage:
	npm run test:coverage 2>&1 | tee coverage-run.log
	@echo ""
	@echo "=== Overall (artizo src only; vendored CLI excluded) ==="
	@grep -E "^All files" coverage-run.log

# ── Build ──────────────────────────────────────────────────────

build: $(NODE_MODULES) $(VENDOR_CLI) $(VENDOR_NM) typecheck
	npm run build
	@echo "Bundle built in dist/. Run 'make package' to create VSIX files."

package: $(NODE_MODULES) $(VENDOR_CLI) $(VENDOR_NM) check-shared-drift docs
	npm run package:kiro
	npm run package:trae
	npm run package:devin
	npm run package:vscodium

package-kiro: $(NODE_MODULES) $(VENDOR_CLI) $(VENDOR_NM) check-shared-drift docs
	npm run package:kiro

package-trae: $(NODE_MODULES) $(VENDOR_CLI) $(VENDOR_NM) check-shared-drift docs
	npm run package:trae

package-devin: $(NODE_MODULES) $(VENDOR_CLI) $(VENDOR_NM) check-shared-drift docs
	npm run package:devin

package-vscodium: $(NODE_MODULES) $(VENDOR_CLI) $(VENDOR_NM) check-shared-drift docs
	npm run package:vscodium

# ── Release ────────────────────────────────────────────────────

release:
	@test -n "$(VERSION)" || (echo "Usage: make release VERSION=x.y.z" && exit 1)
	@echo "=== Releasing version $(VERSION) ==="
	npm version $(VERSION) --no-git-tag-version
	$(MAKE) check
	$(MAKE) package
	git add package.json package-lock.json
	git commit -m "Release $(VERSION)"
	git tag "v$(VERSION)"
	@echo "=== Release $(VERSION) ready ==="
	@echo "Next: git push --follow-tags, then make publish"

# ── Publish ────────────────────────────────────────────────────

publish: package
	@test -n "$$OVSX_PAT" || (echo "Set OVSX_PAT environment variable" && exit 1)
	npx ovsx publish artizo-kiro-*.vsix
	npx ovsx publish artizo-trae-*.vsix
	npx ovsx publish artizo-devin-*.vsix
	npx ovsx publish artizo-vscodium-*.vsix

# ── Shared-file sync ─────────────────────────────────────────
#
# sync-shared: manually copy files listed in SHARED_FROM_ZYGOS from
# ../zygos. Run after editing shared files in zygos.
#
# check-shared-drift: automatic, runs in build/check. Warns (no copy,
# no fail) when ../zygos exists and any shared file differs from the
# zygos source. Silent when ../zygos is absent (customers building from
# source without zygos checked out alongside).

sync-shared:
	@for pair in $(SHARED_FROM_ZYGOS); do \
    src=$${pair%%:*}; \
    dst=$${pair##*:}; \
    if [ ! -f "../zygos/$$src" ]; then \
      echo "  MISSING ../zygos/$$src" >&2; \
      exit 1; \
    fi; \
    if ! cmp -s "../zygos/$$src" "$$dst"; then \
      mkdir -p "$$(dirname "$$dst")"; \
      cp "../zygos/$$src" "$$dst"; \
      echo "  updated $$dst"; \
    fi; \
  done
	@echo "Sync complete."

check-shared-drift:
	@if [ -d ../zygos ]; then \
    drifted=0; \
    for pair in $(SHARED_FROM_ZYGOS); do \
      src=$${pair%%:*}; \
      dst=$${pair##*:}; \
      if [ -f "../zygos/$$src" ] && ! cmp -s "../zygos/$$src" "$$dst"; then \
        echo "  DRIFT: $$dst differs from ../zygos/$$src (run 'make sync-shared')" >&2; \
        drifted=1; \
      fi; \
    done; \
    if [ "$$drifted" = "1" ]; then \
      echo "Shared files out of sync with ../zygos." >&2; \
    fi; \
  fi

# ── README template sync ─────────────────────────────────────
#
# Regenerates vendor/README.template.md and vendor/vscodium/README.md
# from sections in the main README.md. Edit README.md, then run `make docs`.
# The vendor templates use {{section:name}} placeholders that are filled
# from <!-- BEGIN:name --> ... <!-- END:name --> blocks in README.md.

docs:
	@node scripts/build-readme.mjs

# ── VSCodium version feed ──────────────────────────────────────
#
# Refresh the bundled VSCodium release version list. Fresh download every
# run; not part of `build` so builds stay offline and reproducible.
# Review and commit the updated file.

vscodium-versions:
	@node scripts/download-vscodium-versions.mjs

# ── Clean ─────────────────────────────────────────────────────
# clean:     removes build artifacts only (dist/, coverage/).
#            node_modules/ sentinel is untouched - no re-setup needed.
# distclean: also removes node_modules/ + vendored CLI build.
#            sentinels are gone -> next make auto-recovers.

clean:
	rm -f artizo-*.vsix
	rm -rf dist coverage

distclean: clean
	rm -rf node_modules
	rm -rf vendor/devcontainers-cli/node_modules
	rm -rf vendor/devcontainers-cli/dist
