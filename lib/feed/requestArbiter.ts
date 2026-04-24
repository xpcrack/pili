export type FeedRequestPriority = 'foreground' | 'background';

export type FeedRequestRejectReason = 'foreground_inflight' | 'background_inflight';

export interface FeedRequestTicket {
  accepted: boolean;
  reason?: FeedRequestRejectReason;
  signal?: AbortSignal;
  abortedByPreemption?: () => boolean;
  finish: () => void;
}

interface ActiveRequest {
  id: number;
  priority: FeedRequestPriority;
  controller: AbortController;
  preempted: boolean;
}

export class FeedRequestArbiter {
  private seq = 0;
  private active: ActiveRequest | null = null;

  start(priority: FeedRequestPriority): FeedRequestTicket {
    const current = this.active;
    if (!current) {
      return this.createAccepted(priority);
    }

    if (current.priority === 'foreground' && priority === 'background') {
      return this.createRejected('foreground_inflight');
    }

    if (current.priority === 'background' && priority === 'foreground') {
      current.preempted = true;
      current.controller.abort();
      return this.createAccepted(priority);
    }

    return this.createRejected(priority === 'foreground' ? 'foreground_inflight' : 'background_inflight');
  }

  private createRejected(reason: FeedRequestRejectReason): FeedRequestTicket {
    return {
      accepted: false,
      reason,
      finish: () => undefined,
    };
  }

  private createAccepted(priority: FeedRequestPriority): FeedRequestTicket {
    const request: ActiveRequest = {
      id: ++this.seq,
      priority,
      controller: new AbortController(),
      preempted: false,
    };
    this.active = request;

    return {
      accepted: true,
      signal: request.controller.signal,
      abortedByPreemption: () => request.preempted,
      finish: () => {
        if (this.active?.id === request.id) {
          this.active = null;
        }
      },
    };
  }
}
