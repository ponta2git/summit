import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error"
    }
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    rules: {
      "no-console": ["error"],
      "@typescript-eslint/no-explicit-any": ["error"],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='process'][property.name='env']",
          message:
            "Use env from src/env.ts. process.env is forbidden in application code."
        }
      ]
    }
  },
  {
    files: [
      "src/env.ts",
      "src/index.ts",
      "src/commands/sync.ts",
      "src/db/seed.ts"
    ],
    rules: {
      "no-restricted-syntax": "off"
    }
  },
  {
    ignores: ["dist/**", "node_modules/**", "drizzle/**"]
  }
);
