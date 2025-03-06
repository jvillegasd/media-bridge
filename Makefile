.PHONY: help
help:  ## This help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.PHONY: clean
clean: clean-eggs clean-build ## Clean all build files
	@find . -iname '*.pyc' -delete
	@find . -iname '*.pyo' -delete
	@find . -iname '*~' -delete
	@find . -iname '*.swp' -delete
	@find . -iname '__pycache__' -exec rm -rv {} +

.PHONY: clean-eggs
clean-eggs:
	@find . -name '*.egg' -print0|xargs -0 rm -rf --
	@rm -rf .eggs/

.PHONY: clean # Clean all build files
clean-build:
	@rm -fr *.egg-info
	@find . -iname '.pytest_cache' -exec rm -rv {} +
	@find . -iname '.pytest_cache' -exec rm -rv {} +
	@find . -iname '.mypy_cache' -exec rm -rv {} +

###
# Pre-Commit section
###
.PHONY: precommit-install
precommit-install:  # Install pre-commit hooks
	@pre-commit install

.PHONY: precommit-all
precommit-all: clean precommit-install ## Run pre-commit in all files
	@pre-commit run -a

.PHONY: precommit
precommit: clean precommit-install## Run pre-commit
	@pre-commit run

###
# Tests section
###
.PHONY: test
test: ## Run tests
	@pytest -s -x -vvv --cov-report=html 

.PHONY: show-cov
show-cov: ## Open test coverage in browser
	@open htmlcov/index.html
