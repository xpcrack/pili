interface GlobalCompletenessVisibilityInput {
  selectedUserId: string | null;
  completenessWindow:
    | {
        complete: boolean;
      }
    | null;
}

export function shouldShowGlobalCompletenessWindow(input: GlobalCompletenessVisibilityInput) {
  return input.selectedUserId === null && input.completenessWindow?.complete === true;
}
