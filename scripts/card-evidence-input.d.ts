export interface ViewerInputPaths {
    reportPath: string;
    outputRoot: string;
    sourceManifestPath: string;
}
export interface CatalogSpec {
    readonly file: string;
    readonly titlePath: readonly string[];
}
declare const validatedBrand: unique symbol;
export interface ValidatedViewerEvidence {
    readonly [validatedBrand]: true;
    readonly testedTree: string;
    readonly reportSha256: string;
    readonly files: Readonly<Record<string, string>>;
    readonly traces: Readonly<Record<string, Readonly<{
        path: string;
        sha256: string;
    }>>>;
}
export declare function validateCurrentEvidenceSources(context: ValidatedViewerEvidence, repoRoot: string): void;
/** Evidence documents reject duplicate JSON keys before schema validation. */
export declare function parseEvidenceJson(text: string): unknown;
export declare function discoverGeneratorSourceFiles(repoRoot: string, generatorPath: string): string[];
export declare function getViewerEvidenceSourceFiles(repoRoot: string): string[];
export declare function loadViewerEvidence(paths: ViewerInputPaths, options: {
    repoRoot: string;
    sourceFiles: readonly string[];
    catalog: readonly CatalogSpec[];
}): Promise<ValidatedViewerEvidence>;
export declare function loadGeneratorViewerEvidence(argv: readonly string[], repoRoot?: string): Promise<ValidatedViewerEvidence | undefined>;
export declare function parseViewerEvidenceOptions(argv: readonly string[]): ViewerInputPaths | undefined;
export declare const VIEWER_CATALOG: readonly CatalogSpec[];
export {};
//# sourceMappingURL=card-evidence-input.d.ts.map