.PHONY: dev stop help
.DEFAULT_GOAL := help

dev: ## Start the full local stack (Supabase + API + MCP + frontend); Ctrl-C stops it
	@./scripts/dev.sh up

stop: ## Stop the local Supabase stack
	@./scripts/dev.sh down

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*## "}{printf "  make %-6s %s\n", $$1, $$2}'
