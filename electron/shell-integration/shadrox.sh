# ShadRox shell integration for bash.
# OSC 133 / 633 markers, original script, public protocol letters only.
if [ -n "$HOME" ] && [ -f "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi

__shadrox_preexec() {
  case "$1" in
    __shadrox_*|PROMPT_COMMAND*) return ;;
  esac
  printf '\033]633;E;%s\007\033]133;C\007' "$1"
}

__shadrox_precmd() {
  local ec=$?
  printf '\033]133;D;%s\007\033]633;P;Cwd=%s\007\033]133;A\007\033]133;B\007' "$ec" "$PWD"
}

if [ -n "$BASH_VERSION" ]; then
  trap '__shadrox_preexec "$BASH_COMMAND"' DEBUG
  PROMPT_COMMAND="__shadrox_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
