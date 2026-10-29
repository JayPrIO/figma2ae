# Figma2AE — top-level developer commands. Requires Node 20+ (see .nvmrc).
.DEFAULT_GOAL := help
.PHONY: help install build build-dev test test-watch bench typecheck check package release install-ae uninstall-ae dev-bridge site clean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install dependencies (npm workspaces)
	npm ci

build: ## Build Figma plugin, AE panel + ES3 builder, dev bridge into ./dist
	node scripts/build.mjs

build-dev: ## Unminified build with CEP remote debugging (localhost:8092)
	node scripts/build.mjs --dev

test: ## Run all unit, integration and E2E tests
	npx vitest run

test-watch: ## Tests in watch mode
	npx vitest

bench: ## Run micro-benchmarks
	npx vitest bench --run

typecheck: ## Strict TypeScript across all workspaces (jsx sources against lib ES5)
	npm run typecheck

check: typecheck test ## Typecheck + tests (what CI runs)
	node scripts/check-sources.mjs
	node scripts/check-site.mjs

package: build ## Build and zip release artifacts into dist/release
	node scripts/package.mjs

install-ae: build ## Build and install the AE panel for this user (macOS)
	sh dist/ae-extension/install.sh

uninstall-ae: ## Remove the AE panel
	sh scripts/install-ae-extension.sh --uninstall

dev-bridge: ## Standalone bridge (no AE): saves synced documents to ./received
	npm run dev:bridge

site: ## Check and preview the GitHub Pages site at http://localhost:8080
	node scripts/check-site.mjs
	cd site && python3 -m http.server 8080

clean: ## Remove build outputs
	rm -rf dist */dist received
