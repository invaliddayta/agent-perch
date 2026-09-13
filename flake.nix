{
  description = "Agent Perch native tmux browser terminals";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      eachSystem = nixpkgs.lib.genAttrs systems;
    in {
      packages = eachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
          src = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter = path: type:
              let name = baseNameOf path; in
              !(builtins.elem name [ ".git" "node_modules" "dist" ".state" "result" ]) &&
              !(pkgs.lib.hasPrefix ".env" name && name != ".env.example") &&
              !(pkgs.lib.hasPrefix (toString ./. + "/public/models") path) &&
              !(pkgs.lib.hasPrefix (toString ./. + "/public/speech") path) &&
              !(pkgs.lib.hasPrefix (toString ./. + "/public/ort") path);
          };
          dependencies = pkgs.stdenvNoCC.mkDerivation {
            pname = "agent-perch-bun-dependencies";
            inherit version;
            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [ ./package.json ./bun.lock ];
            };
            nativeBuildInputs = [ pkgs.bun pkgs.cacert ];
            dontFixup = true;
            buildPhase = ''
              export HOME="$TMPDIR/home"
              mkdir -p "$HOME"
              bun install --frozen-lockfile --ignore-scripts --no-cache --backend copy --os '*' --cpu '*'
            '';
            installPhase = ''
              mv node_modules "$out"
            '';
            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            outputHash = "sha256-jsnqWn10KBtwRA+/pe6GHvnLrnW/hbxn/zonE66kpGA=";
          };
          perch = pkgs.stdenvNoCC.mkDerivation {
            pname = "agent-perch";
            inherit version src;
            nativeBuildInputs = [ pkgs.bun pkgs.makeWrapper ];
            buildPhase = ''
              export HOME="$TMPDIR/home"
              mkdir -p "$HOME"
              cp -R ${dependencies} node_modules
              chmod -R u+w node_modules
              bun node_modules/typescript/bin/tsc --noEmit
              bun node_modules/vite/bin/vite.js build
              bun scripts/third-party-notices.ts THIRD_PARTY_NOTICES.txt
            '';
            installPhase = ''
              mkdir -p "$out/lib/agent-perch" "$out/bin"
              cp -R server src scripts integrations dist package.json LICENSE THIRD_PARTY_NOTICES.txt "$out/lib/agent-perch/"
              makeWrapper ${pkgs.bun}/bin/bun "$out/bin/agent-perch" \
                --add-flags "--no-env-file --no-install $out/lib/agent-perch/server/index.ts" \
                --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.tmux pkgs.coreutils pkgs.bash ]} \
                --set-default DIST_DIR "$out/lib/agent-perch/dist" \
                --run 'export STATE_DIR="''${STATE_DIR:-''${XDG_STATE_HOME:-$HOME/.local/state}/agent-perch}"'
            '';
            meta = { description = "Private browser terminals for native coding agents"; license = pkgs.lib.licenses.mit; platforms = systems; mainProgram = "agent-perch"; };
          };
        in { default = perch; agent-perch = perch; });
      apps = eachSystem (system: {
        default = { type = "app"; program = "${self.packages.${system}.default}/bin/agent-perch"; };
      });
    };
}
