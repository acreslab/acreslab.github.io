#!/bin/zsh
# Local preview: opens http://localhost:4000 and reloads the page whenever you save a file.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/opt/ruby/bin:$PATH"
bundle exec jekyll serve --livereload --open-url
