import type { DirectiveDto, DocumentDto } from "@nexus/core";
import { create } from "zustand";

interface DocsState {
  documents: DocumentDto[];
  directives: DirectiveDto[];
  setDocuments(docs: DocumentDto[]): void;
  addDocument(doc: DocumentDto): void;
  setDirectives(d: DirectiveDto[]): void;
}

export const useDocsStore = create<DocsState>((set, get) => ({
  documents: [],
  directives: [],
  setDocuments: (documents) => set({ documents }),
  addDocument: (doc) =>
    set({
      documents: [doc, ...get().documents.filter((d) => d.id !== doc.id)].slice(0, 60),
    }),
  setDirectives: (directives) => set({ directives }),
}));
