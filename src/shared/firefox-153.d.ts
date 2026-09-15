/**
 * Firefox 153 added native WebExtension document identifiers. The published
 * @types package used by this repository still targets Firefox 143, so keep
 * this small declaration merge until the upstream type package catches up.
 */
declare namespace browser.runtime {
  interface MessageSender {
    documentId?: string;
  }
}

declare namespace browser.tabs {
  interface _SendMessageOptions {
    documentId?: string;
  }
}

declare namespace browser.webNavigation {
  interface _OnCommittedDetails {
    documentId?: string;
  }

  interface _OnCompletedDetails {
    documentId?: string;
  }

  interface _OnErrorOccurredDetails {
    documentId?: string;
  }

  interface _GetFrameReturnDetails {
    documentId?: string;
  }
}
