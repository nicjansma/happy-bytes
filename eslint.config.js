import globals from "globals";
import jsdoc from "eslint-plugin-jsdoc";
import nicjansma from "eslint-config-nicjansma/flat";

export default [
    {
        ignores: [
            "node_modules/**",
            "dictionaries/**"
        ]
    },
    nicjansma,
    jsdoc.configs["flat/recommended-error"],
    {
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                ...globals.node
            }
        },
        rules: {
            // Disabled over nicjansma
            "no-process-exit": 0,
            "guard-for-in": 0,

            //
            // JSDoc (replaces nicjansma's valid-jsdoc, which was removed in ESLint 9)
            //
            // Every named function needs a JSDoc block: declarations, class methods, and function /
            // arrow expressions assigned to a variable or property. Inline callbacks (e.g. `.map((x) => ...)`)
            // are exempt.
            "jsdoc/require-jsdoc": ["error", {
                publicOnly: false,
                require: {
                    FunctionDeclaration: true,
                    MethodDefinition: true,
                    ClassDeclaration: true,
                    ArrowFunctionExpression: false,
                    FunctionExpression: false
                },
                contexts: [
                    "VariableDeclarator > ArrowFunctionExpression",
                    "VariableDeclarator > FunctionExpression",
                    "Property > ArrowFunctionExpression",
                    "Property > FunctionExpression"
                ]
            }],
            "jsdoc/require-description": "error",
            "jsdoc/require-param": "error",
            "jsdoc/require-param-type": "error",
            "jsdoc/require-param-description": "error",
            "jsdoc/require-returns": "error",
            "jsdoc/require-returns-type": "error",
            "jsdoc/require-returns-description": "error",
            // Allow types such as Buffer, Response, etc.
            "jsdoc/no-undefined-types": "off",
            // Allow "@returns {void}"-free functions and "returns" (not "return")
            "jsdoc/tag-lines": ["error", "any", { startLines: 1 }]
        },
        settings: {
            jsdoc: {
                tagNamePreference: {
                    returns: "returns"
                }
            }
        }
    }
];
