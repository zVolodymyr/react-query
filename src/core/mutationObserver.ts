import { Action, getDefaultState, Mutation } from './mutation'
import { notifyManager } from './notifyManager'
import type { QueryClient } from './queryClient'
import { Subscribable } from './subscribable'
import type {
  MutateOptions,
  MutationObserverResult,
  MutationObserverOptions,
} from './types'
import { hashMutationKeyByOptions } from './utils'

// TYPES

type MutationObserverListener<TData, TError, TVariables, TContext> = (
  result: MutationObserverResult<TData, TError, TVariables, TContext>
) => void

interface NotifyOptions {
  listeners?: boolean
  onError?: boolean
  onSuccess?: boolean
}

// CLASS

export class MutationObserver<
  TData = unknown,
  TError = unknown,
  TVariables = void,
  TContext = unknown
> extends Subscribable<
  MutationObserverListener<TData, TError, TVariables, TContext>
> {
  options!: MutationObserverOptions<TData, TError, TVariables, TContext>

  private client: QueryClient
  private currentResult!: MutationObserverResult<
    TData,
    TError,
    TVariables,
    TContext
  >
  private currentMutation?: Mutation<TData, TError, TVariables, TContext>
  private mutateOptions?: MutateOptions<TData, TError, TVariables, TContext>

  constructor(
    client: QueryClient,
    options: MutationObserverOptions<TData, TError, TVariables, TContext>
  ) {
    super()

    this.client = client
    this.setOptions(options)
    this.bindMethods()
    this.updateResult()
  }

  protected bindMethods(): void {
    this.mutate = this.mutate.bind(this)
    this.reset = this.reset.bind(this)
  }

  setOptions(
    options?: MutationObserverOptions<TData, TError, TVariables, TContext>
  ) {
    const prevOptions = this.options

    this.options = this.client.defaultMutationOptions(options)

    if (prevOptions && prevOptions.shareable !== options?.shareable) {
      throw new Error(`"shareable" can't be changed`)
    }

    this.updateSharedMutation()
  }

  updateSharedMutation() {
    if (!this.options.shareable) {
      return
    }

    if (!this.options.mutationKey) {
      throw new Error(`Shareable mutation requires mutationKey to be set`)
    }

    const hash = hashMutationKeyByOptions(
      this.options.mutationKey,
      this.options
    )
    const mutation = this.client
      .getMutationCache()
      .get<TData, TError, TVariables, TContext>(hash)

    if (this.currentMutation === mutation) {
      return
    }

    this.currentMutation?.removeObserver(this);
    this.currentMutation = mutation
    this.currentMutation?.addObserver(this)

    this.updateResult()
  }

  protected onUnsubscribe(): void {
    if (!this.listeners.length) {
      this.currentMutation?.removeObserver(this)
    }
  }

  onMutationUpdate(action: Action<TData, TError, TVariables, TContext>): void {
    this.updateResult()

    // Determine which callbacks to trigger
    const notifyOptions: NotifyOptions = {
      listeners: true,
    }

    if (action.type === 'success') {
      notifyOptions.onSuccess = true
    } else if (action.type === 'error') {
      notifyOptions.onError = true
    }

    this.notify(notifyOptions)
  }

  getCurrentResult(): MutationObserverResult<
    TData,
    TError,
    TVariables,
    TContext
  > {
    return this.currentResult
  }

  reset(): void {
    this.currentMutation = undefined
    this.updateResult()
    this.notify({ listeners: true })
  }

  mutate(
    variables?: TVariables,
    options?: MutateOptions<TData, TError, TVariables, TContext>
  ): Promise<TData> {
    this.mutateOptions = options

    if (this.currentMutation) {
      this.currentMutation.removeObserver(this)
    }

    this.currentMutation = this.client.getMutationCache().build(this.client, {
      ...this.options,
      variables:
        typeof variables !== 'undefined' ? variables : this.options.variables,
    })

    this.currentMutation.addObserver(this)

    return this.currentMutation.execute()
  }

  private updateResult(): void {
    const state = this.currentMutation
      ? this.currentMutation.state
      : getDefaultState<TData, TError, TVariables, TContext>()

    this.currentResult = {
      ...state,
      isLoading: state.status === 'loading',
      isSuccess: state.status === 'success',
      isError: state.status === 'error',
      isIdle: state.status === 'idle',
      mutate: this.mutate,
      reset: this.reset,
    }
  }

  private notify(options: NotifyOptions) {
    notifyManager.batch(() => {
      // First trigger the mutate callbacks
      if (this.mutateOptions) {
        if (options.onSuccess) {
          this.mutateOptions.onSuccess?.(
            this.currentResult.data!,
            this.currentResult.variables!,
            this.currentResult.context!
          )
          this.mutateOptions.onSettled?.(
            this.currentResult.data!,
            null,
            this.currentResult.variables!,
            this.currentResult.context
          )
        } else if (options.onError) {
          this.mutateOptions.onError?.(
            this.currentResult.error!,
            this.currentResult.variables!,
            this.currentResult.context
          )
          this.mutateOptions.onSettled?.(
            undefined,
            this.currentResult.error,
            this.currentResult.variables!,
            this.currentResult.context
          )
        }
      }

      // Then trigger the listeners
      if (options.listeners) {
        this.listeners.forEach(listener => {
          listener(this.currentResult)
        })
      }
    })
  }
}
