`term-mono-*.woff2`: JetBrains Mono (Nerd Font Mono build, OFL-1.1) cut down to what terminals
and pi's TUI draw: Latin, punctuation, arrows, box drawing, blocks, shapes, dingbats, braille
spinners, powerline. Made from the system font with:

    uv run --no-project --with fonttools --with brotli python -m fontTools.subset \
      /usr/share/fonts/TTF/JetBrainsMonoNerdFontMono-Regular.ttf --flavor=woff2 --layout-features='*' \
      --unicodes="U+0000-024F,U+0300-036F,U+2000-206F,U+20A0-20CF,U+2100-214F,U+2190-21FF,U+2200-22FF,U+2300-23FF,U+2460-24FF,U+2500-257F,U+2580-259F,U+25A0-25FF,U+2600-26FF,U+2700-27BF,U+2800-28FF,U+E0A0-E0D7" \
      --output-file=term-mono-Regular.woff2
