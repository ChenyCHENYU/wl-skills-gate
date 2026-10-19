// Gate's isolated engine supplements the project's existing ESLint version.
// It does not replace project configuration or enable automatic writes.
export async function frontendLintConfig(root, analyzer) {
  const [
    { default: tsParser },
    { default: tsPlugin },
    { default: vueParser },
    { default: vue },
    { default: unsanitized },
    { default: security },
    { default: accessibility },
  ] = await Promise.all([
    import("@typescript-eslint/parser"),
    import("@typescript-eslint/eslint-plugin"),
    import("vue-eslint-parser"),
    import("eslint-plugin-vue"),
    import("eslint-plugin-no-unsanitized"),
    import("eslint-plugin-security"),
    import("eslint-plugin-vuejs-accessibility"),
  ]);
  const plugins = {
    "@typescript-eslint": tsPlugin,
    vue,
    "no-unsanitized": unsanitized,
    security,
    "vuejs-accessibility": accessibility,
  };
  const typedRules = {
    "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
    "@typescript-eslint/no-misused-promises": "error",
    "@typescript-eslint/await-thenable": "error",
    "@typescript-eslint/no-for-in-array": "error",
    "@typescript-eslint/no-unnecessary-condition": "warn",
    "@typescript-eslint/switch-exhaustiveness-check": "error",
    "@typescript-eslint/ban-ts-comment": [
      "error",
      { "ts-ignore": true, "ts-nocheck": true, "ts-expect-error": true, "ts-check": false },
    ],
    "@typescript-eslint/no-unsafe-assignment": "warn",
    "@typescript-eslint/no-unsafe-call": "warn",
    "@typescript-eslint/no-unsafe-member-access": "warn",
    "@typescript-eslint/no-unsafe-return": "warn",
    "@typescript-eslint/no-unused-vars": ["error", { args: "all", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
  };
  const securityRules = {
    ...Object.fromEntries(Object.keys(security.configs.recommended.rules).map((rule) => [rule, "warn"])),
    // Computed property access and validated path variables alone are not
    // injection findings. These broad patterns drown real risks in tool repos.
    "security/detect-object-injection": "off",
    "security/detect-non-literal-fs-filename": "off",
    "no-eval": "error",
    "no-implied-eval": "error",
    "no-new-func": "error",
    "no-script-url": "error",
    "no-unsanitized/method": "error",
    "no-unsanitized/property": "error",
    complexity: ["warn", 15],
  };
  return [
    {
      files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,vue}"],
      plugins,
      languageOptions: {
        parser: tsParser,
        ecmaVersion: "latest",
        sourceType: "module",
        parserOptions:
          analyzer === "typed" ? { projectService: true, tsconfigRootDir: root, extraFileExtensions: [".vue"] } : {},
      },
      rules: analyzer === "typed" ? typedRules : securityRules,
    },
    {
      files: ["**/*.vue"],
      languageOptions: {
        parser: vueParser,
        parserOptions: {
          parser: tsParser,
          extraFileExtensions: [".vue"],
          ...(analyzer === "typed" ? { projectService: true, tsconfigRootDir: root } : {}),
        },
      },
      rules:
        analyzer === "typed"
          ? {}
          : {
              "vue/no-v-html": "warn",
              "vue/no-async-in-computed-properties": "error",
              "vue/no-side-effects-in-computed-properties": "error",
              "vue/no-mutating-props": "error",
              "vue/no-watch-after-await": "error",
              "vue/no-lifecycle-after-await": "error",
              ...Object.fromEntries(Object.keys(accessibility.configs.recommended.rules).map((rule) => [rule, "warn"])),
            },
    },
  ];
}
