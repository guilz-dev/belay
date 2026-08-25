.PHONY: _start_test_deps test-fast

TEST_RSPEC_ARGS = $(or $(ARGS),spec)
TEST_DOCKER_RUN = docker-compose run --rm test

test-fast: _start_test_deps
	$(TEST_DOCKER_RUN) /bin/bash -lc "bundle exec rspec $(TEST_RSPEC_ARGS)"
