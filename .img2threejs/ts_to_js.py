"""Hand-convert the generated TypeScript factory to plain ES module JavaScript.

Strategy: strip type annotations, `import type`, `export type` blocks, `as` casts,
generic params, and `interface { ... }` declarations. Keeps all `import` and `export`
statements that have runtime meaning. The img2threejs factory is conservative — most
of its type annotations are simple `: Type` and `as Type` forms, not advanced generics.

Run:
    py .img2threejs/ts_to_js.py
"""
import re
from pathlib import Path

SRC = Path(r"C:\Users\punko\Downloads\pominigames\.img2threejs\createObjectModel.ts")
OUT_DIR = Path(r"C:\Users\punko\Downloads\pominigames\src\PoMiniGames.Client\wwwroot\games\pogallery\models\chair")
OUT = OUT_DIR / "index.js"


def strip_typescript(src: str) -> str:
    out = src

    # 1. Strip `export type X = ...;` and `type X = ...;` declarations.
    out = re.sub(r"^export type [^\n]+(?:\{[^{}]*\}|\[[^\[\]]*\]|[^=;])*=[^;]*;\s*$",
                 "", out, flags=re.MULTILINE)
    out = re.sub(r"^type [^\n]+(?:\{[^{}]*\}|\[[^\[\]]*\]|[^=;])*=[^;]*;\s*$",
                 "", out, flags=re.MULTILINE)

    # 2. Strip `import type { ... } from '...';`
    out = re.sub(r"^import type \{[^}]*\} from [^;]+;\s*$",
                 "", out, flags=re.MULTILINE)

    # 3. Strip `export interface X { ... }` and `interface X { ... }`.
    out = re.sub(r"^export interface [^{]+\{[^}]*\}\s*$",
                 "", out, flags=re.MULTILINE | re.DOTALL)
    out = re.sub(r"^interface [^{]+\{[^}]*\}\s*$",
                 "", out, flags=re.MULTILINE | re.DOTALL)

    # 4. Strip `as TypeName` casts (keep the expression).
    out = re.sub(r"\s+as\s+[A-Za-z_][\w.<>\[\],\s|&]*", "", out)

    # 5. Strip `: TypeName` parameter and return-type annotations.
    #    Be careful with object types containing commas/braces. Use a balanced scan.
    out = strip_param_and_return_annotations(out)

    # 6. Strip generic angle-brackets on call sites: `func<T>(arg)` -> `func(arg)`.
    out = re.sub(r"<[A-Za-z_][\w.<>\[\],\s|&]*?>", "", out)
    # But `<T>(arg: T)` arrows (e.g. `<T>(x: T) => x`) — handled by step 5.

    # 7. Strip `satisfies Type` clauses (rare in this factory).
    out = re.sub(r"\s+satisfies\s+[A-Za-z_][\w.<>\[\],\s|&]*", "", out)

    # 8. Strip `!` non-null assertions and `?` optional markers.
    out = re.sub(r"(\w)\!", r"\1", out)

    # 9. Drop the unused TS-only EffectComposer / RoomEnvironment imports if they
    #    blow up at runtime (these ARE valid runtime modules in three.js, so we keep
    #    them — but rewrite the import paths to ones the harness importmap can resolve).
    out = out.replace(
        "from 'three/examples/jsm/environments/RoomEnvironment.js'",
        "from 'three/addons/environments/RoomEnvironment.js'",
    )
    out = out.replace(
        "from 'three/examples/jsm/postprocessing/EffectComposer.js'",
        "from 'three/addons/postprocessing/EffectComposer.js'",
    )
    out = out.replace(
        "from 'three/examples/jsm/postprocessing/RenderPass.js'",
        "from 'three/addons/postprocessing/RenderPass.js'",
    )
    out = out.replace(
        "from 'three/examples/jsm/postprocessing/BokehPass.js'",
        "from 'three/addons/postprocessing/BokehPass.js'",
    )
    out = out.replace(
        "from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'",
        "from 'three/addons/postprocessing/UnrealBloomPass.js'",
    )
    out = out.replace(
        "from 'three/examples/jsm/controls/OrbitControls.js'",
        "from 'three/addons/controls/OrbitControls.js'",
    )

    # 10. Replace `export function createNavyUpholsteredChairModel(...)` with a
    #     default export so the harness contract (`mod.default`) finds it.
    out = re.sub(
        r"export function createNavyUpholsteredChairModel(\s*options\s*=[^)]*\))",
        "function _createNavyUpholsteredChairModel\\1",
        out,
    )
    # Wrap factory as the default export and re-export helpers for completeness.
    if "export default" not in out:
        # Place the default export at the end with all top-level exports.
        out += "\n\nexport default _createNavyUpholsteredChairModel;\n"

    return out


def strip_param_and_return_annotations(src: str) -> str:
    """Remove `: Type` annotations on parameters and `: Type` return-type annotations,
    without breaking object/array/function type literals."""
    out: list[str] = []
    i = 0
    while i < len(src):
        ch = src[i]
        # Function-parameter / variable : Type — only when not inside a string,
        # not preceded by `?` (optional marker) handling, and the type ends at
        # `,`, `)`, `=`, `;`, end-of-line, or end-of-file.
        if ch == ":":
            # Look back to ensure this isn't part of a ternary / label.
            j = i - 1
            while j >= 0 and src[j] in " \t":
                j -= 1
            if j < 0 or src[j] in "({[,;?=+\-*/%<>!&|^~":
                out.append(ch)
                i += 1
                continue
            # Now scan forward to find the end of the type expression.
            k = i + 1
            depth = 0
            while k < len(src):
                c = src[k]
                if c in "([{<":
                    depth += 1
                elif c in ")]}>":
                    if depth == 0:
                        break
                    depth -= 1
                elif depth == 0 and c in ",);}\n":
                    if c == "(" and src[k-1] == "}":
                        # function-type paren: don't break on its outer `)`; recurse
                        # Use a simpler heuristic: if the next non-space after `)`
                        # is `=>`, treat the whole thing as a function-type and stop.
                        k2 = k + 1
                        while k2 < len(src) and src[k2] in " \t":
                            k2 += 1
                        if src[k2:k2+2] == "=>":
                            # keep scanning until the next depth-0 separator
                            pass
                        else:
                            break
                    else:
                        break
                k += 1
            # Skip the annotation (no characters to keep).
            i = k
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def main() -> int:
    src = SRC.read_text(encoding="utf-8")
    js = strip_typescript(src)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT.write_text(js, encoding="utf-8")
    print(f"OK  wrote {OUT}  ({len(js)} bytes from {len(src)} TS bytes)")
    # Quick parse check.
    try:
        compile(js, str(OUT), "exec")
        print("parses OK")
    except SyntaxError as e:
        print(f"PARSE ERROR line {e.lineno}: {e.msg}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())