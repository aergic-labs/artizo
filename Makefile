# Artizo — local development and release automation
# =================================================
#
# ── Boundary ───────────────────────────────────────────────────
# package.json scripts = atomic, single-tool commands (tsc, vitest, esbuild, knip)
# Makefile              = orchestration (pipelines, release, cleanup, setup)
#
# Always prefer npm scripts directly during development:
#   npm test              Fast feedback (unit + property, no Docker)
#   npm run test:coverage Coverage report (unit + property)
#   npm run test:all      Everything (unit + property + integration)
#   npm run lint          Type-check + dead-code detection
#   npm run build         esbuild bundle only (no VSIX)
#   npm run package:kiro  Build a single VSIX for Kiro
#
# Makefile targets:
#   make setup            Explicit one-time setup (also runs automatically when needed)
#   make check            Full quality gate (lint + test:all)
#   make build            Build all three platform VSIX files
#   make release VERSION=x.y.z   Bump version, check, build, tag
#   make publish          Publish all three VSIX files to Open VSX
#   make clean            Remove build artifacts (safe, no re-setup needed)
#   make distclean        Nuclear clean (auto-recovers on next make)
#
# Make uses sentinel files to auto-resolve dependencies:
#   node_modules/.package-lock.json   tracks root npm install
#   vendor/devcontainers-cli/.git      tracks the vendored submodule checkout
# If either is missing or out-of-date, Make rebuilds it automatically.
#
# Publishing requires:
#   OVSX_PAT environment variable (Personal Access Token from open-vsx.org)
#   Publisher namespace claimed on Open VSX (one-time setup)

.PHONY: setup check lint typecheck test test-all test-coverage build release publish clean distclean

# ── Sentinel files ─────────────────────────────────────────────

NODE_MODULES := node_modules/.package-lock.json
VENDOR_CLI   := vendor/devcontainers-cli/src/spec-node/devContainers.ts

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

# ── Explicit setup (convenience, equivalent to the chain above) ─

setup: $(VENDOR_CLI)

# ── Quality gates ──────────────────────────────────────────────

check: $(NODE_MODULES) lint test-all
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

# ── Build ──────────────────────────────────────────────────────

build: $(NODE_MODULES) $(VENDOR_CLI)
	npm run package:kiro
	npm run package:trae
	npm run package:devin
	npm run package:vscodium

# ── Release ────────────────────────────────────────────────────

release:
	@test -n "$(VERSION)" || (echo "Usage: make release VERSION=x.y.z" && exit 1)
	@echo "=== Releasing version $(VERSION) ==="
	npm version $(VERSION) --no-git-tag-version
	$(MAKE) check
	$(MAKE) build
	git add package.json package-lock.json
	git commit -m "Release $(VERSION)"
	git tag "v$(VERSION)"
	@echo "=== Release $(VERSION) ready ==="
	@echo "Next: git push --follow-tags, then make publish"

# ── Publish ────────────────────────────────────────────────────

publish:
	@test -n "$$OVSX_PAT" || (echo "Set OVSX_PAT environment variable" && exit 1)
	npx ovsx publish artizo-kiro-*.vsix
	npx ovsx publish artizo-trae-*.vsix
	npx ovsx publish artizo-devin-*.vsix
	npx ovsx publish artizo-vscodium-*.vsix

# ── Clean ──────────────────────────────────────────────────────
# clean:     removes build artifacts only (dist/, coverage/).
#            node_modules/ sentinel is untouched — no re-setup needed.
# distclean: also removes node_modules/ + vendored CLI build.
#            sentinels are gone → next make auto-recovers.

clean:
	rm -f artizo-*.vsix
	rm -rf dist coverage

distclean: clean
	rm -rf node_modules
	rm -rf vendor/devcontainers-cli/node_modules
	rm -rf vendor/devcontainers-cli/dist
