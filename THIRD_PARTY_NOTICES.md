# Third-party notices

## XMage

Some card definitions in this repository were translated from XMage's card implementations by
`scripts/xmage-import/` (translated patches carry `"source": "xmage@<commit>"`). XMage is
available at https://github.com/magefree/mage under the following license:

```
MIT License

Copyright (c) 2010 betasteward@gmail.com

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fonts

The viewer ships Latin subsets of three typefaces in `apps/web/src/assets/fonts/`, each under the
SIL Open Font License 1.1. The full licence text for each sits beside its font file
(`OFL-*.txt`).

- **Bodoni Moda**: Copyright 2020 The Bodoni Moda Project Authors
  (https://github.com/indestructible-type/Bodoni). Instanced at weight 400, optical size axis kept.
- **Archivo**: Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo).
  Instanced at width 100, weights 400 to 500.
- **Cutive Mono**: Copyright 2012 The Cutive Project Authors
  (https://github.com/googlefonts/cutivemono).

The files were taken from the Google Fonts repository (https://github.com/google/fonts), subset to
Latin with fontTools, and saved as WOFF. Under the licence these modified versions keep their
original family names only because no Reserved Font Name is declared for them.
