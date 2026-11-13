`greet()` and `card()` each rebuild the same "use the name, else call them
friend" fallback, and neither of them trims. Pull that rule into one helper and
make both call sites use it, without changing the greetings themselves.
