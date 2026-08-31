# Mobile App State Management Architecture

## State Management Overview

### Complete State Architecture
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       MOBILE STATE MANAGEMENT                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                         UI LAYER                                        │ │
│ │                                                                         │ │
│ │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │ │
│ │  │ Dashboard   │  │ Record      │  │ Settings    │  │ Notification    │ │ │
│ │  │ Screen      │  │ List        │  │ Screen      │  │ Components      │ │ │
│ │  │             │  │             │  │             │  │                 │ │ │
│ │  │• useStore   │  │• useStore   │  │• useStore   │  │• useStore       │ │ │
│ │  │• useEffect  │  │• useQuery   │  │• useState   │  │• useRealTime    │ │ │
│ │  │• useMemo    │  │• useInfinite│  │• useForm    │  │• usePush        │ │ │
│ │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────┘ │ │
│ │           │                │                │                │           │ │
│ │           └────────────────┼────────────────┼────────────────┘           │ │
│ │                            │                │                            │ │
│ │                            ▼                ▼                            │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                      REACT HOOKS LAYER                         │   │ │
│ │  │                                                                 │   │ │
│ │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │   │ │
│ │  │  │ Custom      │  │ Data        │  │ Sync        │             │   │ │
│ │  │  │ Hooks       │  │ Hooks       │  │ Hooks       │             │   │ │
│ │  │  │             │  │             │  │             │             │   │ │
│ │  │  │• useAuth    │  │• useQuery   │  │• useSync    │             │   │ │
│ │  │  │• useTenant  │  │• useMutation│  │• useOffline │             │   │ │
│ │  │  │• useTheme   │  │• useCache   │  │• useConflict│             │   │ │
│ │  │  │• useForm    │  │• usePaginate│  │• useQueue   │             │   │ │
│ │  │  └─────────────┘  └─────────────┘  └─────────────┘             │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                        │
│                                    ▼                                        │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                        STATE STORE LAYER                               │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                       ZUSTAND STORE                            │   │ │
│ │  │                                                                 │   │ │
│ │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │   │ │
│ │  │  │ App Store   │  │ Data Store  │  │ Sync Store  │             │   │ │
│ │  │  │             │  │             │  │             │             │   │ │
│ │  │  │• UI state   │  │• Entities   │  │• Queue      │             │   │ │
│ │  │  │• Navigation │  │• Cache      │  │• Status     │             │   │ │
│ │  │  │• Loading    │  │• Query      │  │• Conflicts  │             │   │ │
│ │  │  │• Errors     │  │  results    │  │• Network    │             │   │ │
│ │  │  │• Modals     │  │• Mutations  │  │  state      │             │   │ │
│ │  │  └─────────────┘  └─────────────┘  └─────────────┘             │   │ │
│ │  │                                                                 │   │ │
│ │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │   │ │
│ │  │  │ Auth Store  │  │ Theme Store │  │ Settings    │             │   │ │
│ │  │  │             │  │             │  │ Store       │             │   │ │
│ │  │  │• User info  │  │• Colors     │  │• Preferences│             │   │ │
│ │  │  │• Tokens     │  │• Fonts      │  │• Feature    │             │   │ │
│ │  │  │• Permissions│  │• Layout     │  │  flags      │             │   │ │
│ │  │  │• Session    │  │• Dark mode  │  │• Language   │             │   │ │
│ │  │  └─────────────┘  └─────────────┘  └─────────────┘             │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                        │
│                                    ▼                                        │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                      PERSISTENCE LAYER                                 │ │
│ │                                                                         │ │
│ │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│ │  │                    STORAGE ENGINES                             │   │ │
│ │  │                                                                 │   │ │
│ │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │   │ │
│ │  │  │ SQLite      │  │ AsyncStorage│  │ SecureStore │             │   │ │
│ │  │  │ (WatermelonDB)  │ (React      │  │ (Expo)      │             │   │ │
│ │  │  │             │  │  Native)    │  │             │             │   │ │
│ │  │  │• Entities   │  │             │  │             │             │   │ │
│ │  │  │• Relations  │  │• App state  │  │• Tokens     │             │   │ │
│ │  │  │• Sync queue │  │• Settings   │  │• Biometrics │             │   │ │
│ │  │  │• Cache      │  │• User prefs │  │• Sensitive  │             │   │ │
│ │  │  │• Search idx │  │• Drafts     │  │  data       │             │   │ │
│ │  │  └─────────────┘  └─────────────┘  └─────────────┘             │   │ │
│ │  └─────────────────────────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                        │
│                                    ▼                                        │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                     MIDDLEWARE LAYER                                   │ │
│ │                                                                         │ │
│ │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │ │
│ │  │ Persistence │  │ Sync        │  │ Logging     │  │ Dev Tools       │ │ │
│ │  │ Middleware  │  │ Middleware  │  │ Middleware  │  │ Middleware      │ │ │
│ │  │             │  │             │  │             │  │                 │ │ │
│ │  │• Auto save  │  │• Queue      │  │• Action     │  │• Time travel    │ │ │
│ │  │• Hydration  │  │  management │  │  logging    │  │• State inspect  │ │ │
│ │  │• Serialization│ │• Conflict   │  │• Error      │  │• Performance    │ │ │
│ │  │             │  │  detection  │  │  tracking   │  │  monitoring     │ │ │
│ │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────┘ │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Zustand Store Architecture

### 1. Core Store Definitions
```typescript
// stores/app-store.ts
interface AppState {
  // UI State
  isLoading: boolean;
  loadingMessage: string;
  currentScreen: string;
  navigationHistory: string[];
  
  // Modal & Alert State
  modals: {
    [modalId: string]: {
      isOpen: boolean;
      data?: any;
      options?: ModalOptions;
    };
  };
  
  alerts: Alert[];
  
  // Network & Connectivity
  isOnline: boolean;
  networkType: 'wifi' | '4g' | '3g' | 'none';
  
  // App Lifecycle
  appState: 'active' | 'background' | 'inactive';
  lastActiveTime: number;
}

interface AppActions {
  // Loading Actions
  setLoading: (loading: boolean, message?: string) => void;
  
  // Navigation Actions
  navigateTo: (screen: string) => void;
  goBack: () => void;
  
  // Modal Actions
  openModal: (modalId: string, data?: any, options?: ModalOptions) => void;
  closeModal: (modalId: string) => void;
  closeAllModals: () => void;
  
  // Alert Actions
  showAlert: (alert: Omit<Alert, 'id' | 'timestamp'>) => void;
  dismissAlert: (alertId: string) => void;
  
  // Network Actions
  setOnlineStatus: (online: boolean, networkType?: NetworkType) => void;
  
  // App Lifecycle Actions
  setAppState: (state: AppLifecycleState) => void;
}

export const useAppStore = create<AppState & AppActions>()(
  devtools(
    persist(
      (set, get) => ({
        // Initial State
        isLoading: false,
        loadingMessage: '',
        currentScreen: 'dashboard',
        navigationHistory: [],
        modals: {},
        alerts: [],
        isOnline: true,
        networkType: 'wifi',
        appState: 'active',
        lastActiveTime: Date.now(),
        
        // Actions
        setLoading: (loading, message = '') =>
          set({ isLoading: loading, loadingMessage: message }),
        
        navigateTo: (screen) =>
          set((state) => ({
            currentScreen: screen,
            navigationHistory: [...state.navigationHistory, screen]
          })),
        
        goBack: () =>
          set((state) => {
            const history = [...state.navigationHistory];
            history.pop(); // Remove current
            const previous = history.pop() || 'dashboard';
            return {
              currentScreen: previous,
              navigationHistory: history
            };
          }),
        
        openModal: (modalId, data, options) =>
          set((state) => ({
            modals: {
              ...state.modals,
              [modalId]: { isOpen: true, data, options }
            }
          })),
        
        closeModal: (modalId) =>
          set((state) => ({
            modals: {
              ...state.modals,
              [modalId]: { ...state.modals[modalId], isOpen: false }
            }
          })),
        
        showAlert: (alert) =>
          set((state) => ({
            alerts: [
              ...state.alerts,
              {
                ...alert,
                id: generateId(),
                timestamp: Date.now()
              }
            ]
          })),
        
        setOnlineStatus: (online, networkType = 'wifi') =>
          set({ isOnline: online, networkType }),
        
        setAppState: (appState) =>
          set({
            appState,
            lastActiveTime: appState === 'active' ? Date.now() : get().lastActiveTime
          })
      }),
      {
        name: 'app-store',
        partialize: (state) => ({
          currentScreen: state.currentScreen,
          navigationHistory: state.navigationHistory,
          lastActiveTime: state.lastActiveTime
        })
      }
    ),
    { name: 'AppStore' }
  )
);

┌─────────────────────────────────────────────────────────────────────────────┐
│                            DATA STORE                                       │
├─────────────────────────────────────────────────────────────────────────────┤

// stores/data-store.ts
interface DataState {
  // Entity Cache
  entities: {
    records: Record<string, RecordEntity>;
    files: Record<string, FileEntity>;
    users: Record<string, UserEntity>;
  };
  
  // Query Cache
  queries: {
    [queryKey: string]: {
      data: string[]; // Array of entity IDs
      status: 'idle' | 'loading' | 'success' | 'error';
      error?: string;
      lastUpdated: number;
      nextPageToken?: string;
    };
  };
  
  // Mutations
  mutations: {
    [mutationKey: string]: {
      status: 'idle' | 'loading' | 'success' | 'error';
      error?: string;
      optimisticId?: string;
    };
  };
  
  // Search
  searchResults: {
    [query: string]: {
      results: string[];
      total: number;
      lastUpdated: number;
    };
  };
}

interface DataActions {
  // Entity Management
  setEntity: <T extends keyof DataState['entities']>(
    type: T,
    id: string,
    entity: DataState['entities'][T][string]
  ) => void;
  
  removeEntity: <T extends keyof DataState['entities']>(
    type: T,
    id: string
  ) => void;
  
  // Query Management
  setQuery: (queryKey: string, query: QueryResult) => void;
  invalidateQuery: (queryKey: string) => void;
  invalidateAllQueries: () => void;
  
  // Mutation Management
  setMutation: (mutationKey: string, mutation: MutationState) => void;
  
  // Search
  setSearchResults: (query: string, results: SearchResults) => void;
  clearSearchResults: (query?: string) => void;
  
  // Bulk Operations
  setEntities: <T extends keyof DataState['entities']>(
    type: T,
    entities: Record<string, DataState['entities'][T][string]>
  ) => void;
  
  clearCache: () => void;
}

export const useDataStore = create<DataState & DataActions>()(
  devtools(
    (set, get) => ({
      // Initial State
      entities: {
        records: {},
        files: {},
        users: {}
      },
      queries: {},
      mutations: {},
      searchResults: {},
      
      // Actions
      setEntity: (type, id, entity) =>
        set((state) => ({
          entities: {
            ...state.entities,
            [type]: {
              ...state.entities[type],
              [id]: entity
            }
          }
        })),
      
      removeEntity: (type, id) =>
        set((state) => {
          const newEntities = { ...state.entities[type] };
          delete newEntities[id];
          return {
            entities: {
              ...state.entities,
              [type]: newEntities
            }
          };
        }),
      
      setQuery: (queryKey, query) =>
        set((state) => ({
          queries: {
            ...state.queries,
            [queryKey]: query
          }
        })),
      
      invalidateQuery: (queryKey) =>
        set((state) => {
          const newQueries = { ...state.queries };
          delete newQueries[queryKey];
          return { queries: newQueries };
        }),
      
      setMutation: (mutationKey, mutation) =>
        set((state) => ({
          mutations: {
            ...state.mutations,
            [mutationKey]: mutation
          }
        })),
      
      setSearchResults: (query, results) =>
        set((state) => ({
          searchResults: {
            ...state.searchResults,
            [query]: results
          }
        })),
      
      clearCache: () =>
        set({
          entities: { records: {}, files: {}, users: {} },
          queries: {},
          mutations: {},
          searchResults: {}
        })
    }),
    { name: 'DataStore' }
  )
);

┌─────────────────────────────────────────────────────────────────────────────┐
│                            SYNC STORE                                       │
├─────────────────────────────────────────────────────────────────────────────┤

// stores/sync-store.ts
interface SyncState {
  // Sync Status
  lastSyncTime: number;
  isSyncing: boolean;
  syncProgress: number; // 0-1
  
  // Queue Management
  pendingChanges: PendingChange[];
  failedChanges: FailedChange[];
  
  // Conflict Resolution
  conflicts: ConflictItem[];
  
  // Network State
  connectionQuality: 'excellent' | 'good' | 'poor' | 'offline';
  syncSettings: {
    autoSync: boolean;
    syncOnWifiOnly: boolean;
    syncInterval: number; // minutes
    maxRetries: number;
  };
}

interface SyncActions {
  // Sync Operations
  startSync: () => Promise<void>;
  cancelSync: () => void;
  setSyncStatus: (syncing: boolean, progress?: number) => void;
  
  // Queue Management
  addPendingChange: (change: Omit<PendingChange, 'id' | 'timestamp'>) => void;
  removePendingChange: (changeId: string) => void;
  movePendingToFailed: (changeId: string, error: string) => void;
  retryFailedChange: (changeId: string) => void;
  clearFailedChanges: () => void;
  
  // Conflict Resolution
  addConflict: (conflict: ConflictItem) => void;
  resolveConflict: (conflictId: string, resolution: ConflictResolution) => void;
  
  // Settings
  updateSyncSettings: (settings: Partial<SyncState['syncSettings']>) => void;
  
  // Network
  setConnectionQuality: (quality: SyncState['connectionQuality']) => void;
}

export const useSyncStore = create<SyncState & SyncActions>()(
  devtools(
    persist(
      (set, get) => ({
        // Initial State
        lastSyncTime: 0,
        isSyncing: false,
        syncProgress: 0,
        pendingChanges: [],
        failedChanges: [],
        conflicts: [],
        connectionQuality: 'excellent',
        syncSettings: {
          autoSync: true,
          syncOnWifiOnly: false,
          syncInterval: 5, // 5 minutes
          maxRetries: 3
        },
        
        // Actions
        startSync: async () => {
          const state = get();
          if (state.isSyncing) return;
          
          set({ isSyncing: true, syncProgress: 0 });
          
          try {
            // Sync logic will be implemented in sync service
            await syncService.performSync({
              onProgress: (progress) => set({ syncProgress: progress }),
              onComplete: () => set({
                isSyncing: false,
                syncProgress: 1,
                lastSyncTime: Date.now()
              }),
              onError: () => set({ isSyncing: false, syncProgress: 0 })
            });
          } catch (error) {
            set({ isSyncing: false, syncProgress: 0 });
          }
        },
        
        cancelSync: () => {
          syncService.cancelSync();
          set({ isSyncing: false, syncProgress: 0 });
        },
        
        setSyncStatus: (syncing, progress = 0) =>
          set({ isSyncing: syncing, syncProgress: progress }),
        
        addPendingChange: (change) =>
          set((state) => ({
            pendingChanges: [
              ...state.pendingChanges,
              {
                ...change,
                id: generateId(),
                timestamp: Date.now()
              }
            ]
          })),
        
        removePendingChange: (changeId) =>
          set((state) => ({
            pendingChanges: state.pendingChanges.filter(c => c.id !== changeId)
          })),
        
        addConflict: (conflict) =>
          set((state) => ({
            conflicts: [...state.conflicts, conflict]
          })),
        
        resolveConflict: (conflictId, resolution) =>
          set((state) => ({
            conflicts: state.conflicts.filter(c => c.id !== conflictId)
          })),
        
        updateSyncSettings: (settings) =>
          set((state) => ({
            syncSettings: { ...state.syncSettings, ...settings }
          })),
        
        setConnectionQuality: (quality) =>
          set({ connectionQuality: quality })
      }),
      {
        name: 'sync-store',
        partialize: (state) => ({
          lastSyncTime: state.lastSyncTime,
          pendingChanges: state.pendingChanges,
          failedChanges: state.failedChanges,
          syncSettings: state.syncSettings
        })
      }
    ),
    { name: 'SyncStore' }
  )
);
```

## Custom Hooks Architecture

### 1. Data Management Hooks
```typescript
// hooks/useQuery.ts
interface UseQueryOptions<T> {
  enabled?: boolean;
  refetchOnMount?: boolean;
  refetchOnFocus?: boolean;
  staleTime?: number;
  cacheTime?: number;
  retry?: number;
  onSuccess?: (data: T) => void;
  onError?: (error: Error) => void;
}

export function useQuery<T>(
  queryKey: string | string[],
  queryFn: () => Promise<T>,
  options: UseQueryOptions<T> = {}
) {
  const dataStore = useDataStore();
  const [state, setState] = useState({
    data: undefined as T | undefined,
    isLoading: true,
    isError: false,
    error: undefined as Error | undefined,
    isFetching: false
  });
  
  const keyString = Array.isArray(queryKey) ? queryKey.join(':') : queryKey;
  const cachedQuery = dataStore.queries[keyString];
  
  const fetchData = useCallback(async () => {
    if (!options.enabled) return;
    
    setState(prev => ({ ...prev, isFetching: true }));
    
    try {
      const data = await queryFn();
      
      // Update cache
      dataStore.setQuery(keyString, {
        data: Array.isArray(data) ? data.map(item => item.id) : [data.id],
        status: 'success',
        lastUpdated: Date.now()
      });
      
      setState({
        data,
        isLoading: false,
        isError: false,
        error: undefined,
        isFetching: false
      });
      
      options.onSuccess?.(data);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      
      dataStore.setQuery(keyString, {
        data: [],
        status: 'error',
        error: err.message,
        lastUpdated: Date.now()
      });
      
      setState({
        data: undefined,
        isLoading: false,
        isError: true,
        error: err,
        isFetching: false
      });
      
      options.onError?.(err);
    }
  }, [queryFn, keyString, options]);
  
  // Initial fetch
  useEffect(() => {
    if (options.enabled !== false) {
      fetchData();
    }
  }, [fetchData, options.enabled]);
  
  // Refetch on focus
  useEffect(() => {
    if (options.refetchOnFocus) {
      const handleFocus = () => fetchData();
      AppState.addEventListener('change', handleFocus);
      return () => AppState.removeEventListener('change', handleFocus);
    }
  }, [fetchData, options.refetchOnFocus]);
  
  return {
    ...state,
    refetch: fetchData,
    remove: () => dataStore.invalidateQuery(keyString)
  };
}

┌─────────────────────────────────────────────────────────────────────────────┐
│                         MUTATION HOOK                                       │
├─────────────────────────────────────────────────────────────────────────────┤

// hooks/useMutation.ts
interface UseMutationOptions<T, V> {
  onSuccess?: (data: T, variables: V) => void;
  onError?: (error: Error, variables: V) => void;
  onSettled?: (data: T | undefined, error: Error | undefined, variables: V) => void;
  retry?: number;
  optimisticUpdate?: (variables: V) => void;
  rollbackOptimistic?: () => void;
}

export function useMutation<T, V>(
  mutationFn: (variables: V) => Promise<T>,
  options: UseMutationOptions<T, V> = {}
) {
  const dataStore = useDataStore();
  const syncStore = useSyncStore();
  const [state, setState] = useState({
    data: undefined as T | undefined,
    isLoading: false,
    isError: false,
    error: undefined as Error | undefined
  });
  
  const mutate = useCallback(async (variables: V) => {
    const mutationKey = `mutation_${Date.now()}`;
    
    setState({ data: undefined, isLoading: true, isError: false, error: undefined });
    
    // Optimistic update
    const optimisticId = options.optimisticUpdate ? generateId() : undefined;
    if (options.optimisticUpdate) {
      options.optimisticUpdate(variables);
    }
    
    try {
      // For offline: add to pending queue
      if (!navigator.onLine) {
        syncStore.addPendingChange({
          type: 'mutation',
          data: variables,
          mutationKey,
          optimisticId
        });
        
        setState({
          data: undefined, // Will be set when sync completes
          isLoading: false,
          isError: false,
          error: undefined
        });
        
        return;
      }
      
      // Online: execute immediately
      const data = await mutationFn(variables);
      
      setState({
        data,
        isLoading: false,
        isError: false,
        error: undefined
      });
      
      options.onSuccess?.(data, variables);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      
      // Rollback optimistic update
      if (options.rollbackOptimistic) {
        options.rollbackOptimistic();
      }
      
      setState({
        data: undefined,
        isLoading: false,
        isError: true,
        error: err
      });
      
      options.onError?.(err, variables);
    } finally {
      options.onSettled?.(state.data, state.error, variables);
    }
  }, [mutationFn, options]);
  
  return {
    ...state,
    mutate,
    reset: () => setState({
      data: undefined,
      isLoading: false,
      isError: false,
      error: undefined
    })
  };
}

┌─────────────────────────────────────────────────────────────────────────────┐
│                           SYNC HOOK                                         │
├─────────────────────────────────────────────────────────────────────────────┤

// hooks/useSync.ts
export function useSync() {
  const syncStore = useSyncStore();
  const appStore = useAppStore();
  
  // Auto-sync based on network state
  useEffect(() => {
    if (syncStore.syncSettings.autoSync && appStore.isOnline) {
      const interval = setInterval(() => {
        if (!syncStore.isSyncing) {
          syncStore.startSync();
        }
      }, syncStore.syncSettings.syncInterval * 60 * 1000);
      
      return () => clearInterval(interval);
    }
  }, [
    syncStore.syncSettings.autoSync,
    syncStore.syncSettings.syncInterval,
    syncStore.isSyncing,
    appStore.isOnline
  ]);
  
  // Sync when coming online
  useEffect(() => {
    if (appStore.isOnline && syncStore.pendingChanges.length > 0) {
      syncStore.startSync();
    }
  }, [appStore.isOnline, syncStore.pendingChanges.length]);
  
  return {
    sync: syncStore.startSync,
    cancelSync: syncStore.cancelSync,
    isSyncing: syncStore.isSyncing,
    progress: syncStore.syncProgress,
    lastSyncTime: syncStore.lastSyncTime,
    pendingChanges: syncStore.pendingChanges.length,
    conflicts: syncStore.conflicts.length,
    settings: syncStore.syncSettings,
    updateSettings: syncStore.updateSyncSettings
  };
}

┌─────────────────────────────────────────────────────────────────────────────┐
│                        OFFLINE HOOK                                         │
├─────────────────────────────────────────────────────────────────────────────┤

// hooks/useOffline.ts
export function useOffline() {
  const appStore = useAppStore();
  const syncStore = useSyncStore();
  
  // Monitor network state
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      appStore.setOnlineStatus(
        state.isConnected ?? false,
        state.type as NetworkType
      );
      
      // Update connection quality
      const quality = getConnectionQuality(state);
      syncStore.setConnectionQuality(quality);
    });
    
    return unsubscribe;
  }, []);
  
  // Queue operations when offline
  const queueOperation = useCallback((operation: OfflineOperation) => {
    if (!appStore.isOnline) {
      syncStore.addPendingChange({
        type: operation.type,
        data: operation.data,
        timestamp: Date.now()
      });
      return true; // Queued
    }
    return false; // Not queued, should execute immediately
  }, [appStore.isOnline, syncStore]);
  
  return {
    isOnline: appStore.isOnline,
    networkType: appStore.networkType,
    connectionQuality: syncStore.connectionQuality,
    queueOperation,
    pendingOperations: syncStore.pendingChanges.length,
    canSync: appStore.isOnline && 
             (syncStore.connectionQuality !== 'offline') &&
             (!syncStore.syncSettings.syncOnWifiOnly || appStore.networkType === 'wifi')
  };
}
```

## State Persistence Strategy

### 1. Multi-Layer Persistence
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PERSISTENCE LAYERS                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                       LAYER 1: MEMORY                               │   │
│  │  • React component state (useState, useReducer)                     │   │
│  │  • Computed values (useMemo, useCallback)                           │   │
│  │  • Temporary UI state                                               │   │
│  │  • Form inputs and validation                                       │   │
│  │                                                                     │   │
│  │  Lifetime: Until component unmounts                                 │   │
│  │  Speed: Fastest                                                     │   │
│  │  Persistence: None                                                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    LAYER 2: GLOBAL STATE                           │   │
│  │  • Zustand stores (in-memory)                                      │   │
│  │  • Cross-component shared state                                    │   │
│  │  • Real-time updates                                               │   │
│  │  • Computed/derived state                                          │   │
│  │                                                                     │   │
│  │  Lifetime: Until app restart                                       │   │
│  │  Speed: Very fast                                                  │   │
│  │  Persistence: None (unless configured)                             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                  LAYER 3: ASYNCSTORAGE                             │   │
│  │  • App settings and preferences                                    │   │
│  │  • User session data                                               │   │
│  │  • Cache for frequently accessed data                              │   │
│  │  • Draft content and form data                                     │   │
│  │                                                                     │   │
│  │  Lifetime: Until app uninstall                                     │   │
│  │  Speed: Fast                                                       │   │
│  │  Persistence: Device storage                                       │   │
│  │  Size Limit: ~6MB                                                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                   LAYER 4: SECURE STORE                            │   │
│  │  • Authentication tokens                                           │   │
│  │  • Encryption keys                                                 │   │
│  │  • Biometric data                                                  │   │
│  │  • Sensitive user information                                      │   │
│  │                                                                     │   │
│  │  Lifetime: Until manually cleared                                  │   │
│  │  Speed: Medium                                                     │   │
│  │  Persistence: Encrypted device storage                             │   │
│  │  Security: Hardware-backed encryption                              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                   LAYER 5: SQLITE DATABASE                         │   │
│  │  • Business data entities                                          │   │
│  │  • Relational data with foreign keys                               │   │
│  │  • Full-text search indexes                                        │   │
│  │  • Sync queue and conflict resolution                              │   │
│  │  • Large datasets with complex queries                             │   │
│  │                                                                     │   │
│  │  Lifetime: Until manual deletion                                   │   │
│  │  Speed: Medium to slow (depending on query)                        │   │
│  │  Persistence: Local database file                                  │   │
│  │  Size Limit: Device storage capacity                               │   │
│  │  Features: ACID transactions, relations, indexes                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2. Data Flow Between Layers
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DATA FLOW PATTERNS                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Read Flow (Data Loading):                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │  1. Check Memory (Zustand Store)                                   │   │
│  │     └─ If found: Return immediately                                │   │
│  │                                                                     │   │
│  │  2. Check AsyncStorage Cache                                       │   │
│  │     └─ If found & fresh: Load to memory, return                    │   │
│  │                                                                     │   │
│  │  3. Check SQLite Database                                          │   │
│  │     └─ If found: Load to cache & memory, return                    │   │
│  │                                                                     │   │
│  │  4. Fetch from Server API                                          │   │
│  │     └─ If online: Load to all layers, return                       │   │
│  │     └─ If offline: Return cached data or error                     │   │
│  │                                                                     │   │
│  │  Flow: Memory → Cache → Database → Network                         │   │
│  │  Fallbacks: Each layer falls back to next if miss                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  Write Flow (Data Saving):                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │  1. Update Memory (Zustand Store)                                  │   │
│  │     └─ Immediate UI update                                         │   │
│  │                                                                     │   │
│  │  2. Update SQLite Database                                         │   │
│  │     └─ Persistent storage with transactions                        │   │
│  │                                                                     │   │
│  │  3. Update AsyncStorage Cache                                      │   │
│  │     └─ Quick access for next app start                             │   │
│  │                                                                     │   │
│  │  4. Sync to Server (when online)                                   │   │
│  │     └─ If offline: Queue for later sync                            │   │
│  │                                                                     │   │
│  │  Flow: Memory → Database → Cache → Network                         │   │
│  │  Strategy: Write-through with offline queue                        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  Sync Flow (Online/Offline Coordination):                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │  When Going Offline:                                               │   │
│  │  1. Mark current state in all layers                               │   │
│  │  2. Enable optimistic updates to memory/database                   │   │
│  │  3. Queue all mutations for later sync                             │   │
│  │  4. Continue read operations from local data                       │   │
│  │                                                                     │   │
│  │  When Coming Online:                                               │   │
│  │  1. Process sync queue (pending changes)                           │   │
│  │  2. Resolve conflicts (server vs local)                            │   │
│  │  3. Update all layers with reconciled data                         │   │
│  │  4. Notify UI of any conflicts requiring user input                │   │
│  │                                                                     │   │
│  │  Conflict Resolution:                                               │   │
│  │  • Automatic: Last-write-wins, field-level merge                   │   │
│  │  • Manual: Present conflict UI to user                             │   │
│  │  • Business Rules: Custom resolution logic                         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```