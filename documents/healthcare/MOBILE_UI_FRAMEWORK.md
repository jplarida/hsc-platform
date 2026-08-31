# Mobile UI Settings Framework for Multi-Tenancy

## Tenant Configuration Architecture

### Configuration Structure
```typescript
interface TenantConfig {
  tenantId: string;
  branding: BrandingConfig;
  features: FeatureFlags;
  ui: UIConfiguration;
  workflows: WorkflowConfig;
  permissions: PermissionMatrix;
  industry: IndustrySettings;
}

interface BrandingConfig {
  // Visual Identity
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  logoUrl: string;
  faviconUrl: string;
  
  // Typography
  fontFamily: 'default' | 'sans-serif' | 'serif' | string;
  fontSizes: FontSizeScale;
  
  // App Identity
  appName: string;
  companyName: string;
  tagline?: string;
}

interface UIConfiguration {
  layout: LayoutSettings;
  navigation: NavigationConfig;
  components: ComponentOverrides;
  screens: ScreenConfiguration;
  darkMode: 'enabled' | 'disabled' | 'auto';
}
```

## Dynamic Theming System

### 1. CSS Custom Properties Approach
```css
/* Base theme variables - updated dynamically */
:root {
  --primary-color: #007AFF;
  --secondary-color: #5856D6;
  --accent-color: #FF9500;
  --background-color: #FFFFFF;
  --text-primary: #000000;
  --text-secondary: #666666;
  --border-radius: 8px;
  --shadow-elevation: 0 2px 10px rgba(0,0,0,0.1);
}

/* Dark mode overrides */
@media (prefers-color-scheme: dark) {
  :root {
    --background-color: #1C1C1E;
    --text-primary: #FFFFFF;
    --text-secondary: #8E8E93;
  }
}

/* Tenant-specific overrides injected via JavaScript */
.tenant-healthcare {
  --primary-color: #0066CC;
  --secondary-color: #00A86B;
  --accent-color: #FF6B6B;
}

.tenant-retail {
  --primary-color: #E91E63;
  --secondary-color: #9C27B0;
  --accent-color: #FF9800;
}
```

### 2. React Context for Theme Management
```typescript
// Theme Context Provider
interface ThemeContextType {
  theme: TenantTheme;
  isDarkMode: boolean;
  toggleDarkMode: () => void;
  updateTheme: (newTheme: Partial<TenantTheme>) => void;
}

const ThemeContext = createContext<ThemeContextType>();

// Theme Provider Component
export const ThemeProvider: React.FC<{ tenantConfig: TenantConfig }> = ({ 
  children, 
  tenantConfig 
}) => {
  const [theme, setTheme] = useState(tenantConfig.branding);
  const [isDarkMode, setIsDarkMode] = useState(false);

  useEffect(() => {
    // Apply CSS custom properties
    applyThemeVariables(theme, isDarkMode);
  }, [theme, isDarkMode]);

  return (
    <ThemeContext.Provider value={{ theme, isDarkMode, toggleDarkMode, updateTheme }}>
      <IonApp className={`tenant-${tenantConfig.tenantId} ${isDarkMode ? 'dark' : 'light'}`}>
        {children}
      </IonApp>
    </ThemeContext.Provider>
  );
};
```

## Feature Flag System

### Feature Flag Configuration
```typescript
interface FeatureFlags {
  // Core Features
  offlineSync: boolean;
  realTimeUpdates: boolean;
  fileUpload: boolean;
  pushNotifications: boolean;
  
  // Industry-specific Features
  hipaaCompliance: boolean;
  inventoryManagement: boolean;
  appointmentScheduling: boolean;
  paymentProcessing: boolean;
  documentSigning: boolean;
  
  // UI Features
  darkModeToggle: boolean;
  customFields: boolean;
  advancedFiltering: boolean;
  exportData: boolean;
  bulkActions: boolean;
  
  // Advanced Features
  apiAccess: boolean;
  webhooks: boolean;
  customReports: boolean;
  multiLanguage: boolean;
}

// Feature Flag Hook
export const useFeatureFlag = (flag: keyof FeatureFlags): boolean => {
  const { tenantConfig } = useTenant();
  return tenantConfig.features[flag] ?? false;
};

// Usage in Components
const Dashboard: React.FC = () => {
  const canExportData = useFeatureFlag('exportData');
  const hasRealTime = useFeatureFlag('realTimeUpdates');
  
  return (
    <IonContent>
      {/* Component renders based on feature flags */}
      {canExportData && <ExportButton />}
      {hasRealTime && <RealTimeIndicator />}
    </IonContent>
  );
};
```

## Configurable UI Components

### 1. Dynamic Form Builder
```typescript
interface FormSchema {
  id: string;
  title: string;
  fields: FormField[];
  validation: ValidationRules;
  workflow: WorkflowSteps;
}

interface FormField {
  id: string;
  type: 'text' | 'email' | 'number' | 'select' | 'multiselect' | 'date' | 'file';
  label: string;
  placeholder?: string;
  required: boolean;
  options?: SelectOption[]; // for select fields
  validation?: FieldValidation;
  dependsOn?: string; // field dependency
  industry?: string[]; // industry-specific fields
}

// Dynamic Form Component
const DynamicForm: React.FC<{ schema: FormSchema }> = ({ schema }) => {
  const [formData, setFormData] = useState({});
  const tenantConfig = useTenant();
  
  const visibleFields = schema.fields.filter(field => 
    !field.industry || field.industry.includes(tenantConfig.industry.type)
  );

  return (
    <form>
      {visibleFields.map(field => (
        <DynamicField 
          key={field.id} 
          field={field} 
          value={formData[field.id]} 
          onChange={(value) => updateField(field.id, value)}
        />
      ))}
    </form>
  );
};
```

### 2. Configurable Navigation
```typescript
interface NavigationConfig {
  tabs: TabConfig[];
  sidebar: SidebarConfig;
  header: HeaderConfig;
  bottomNav: boolean;
}

interface TabConfig {
  id: string;
  label: string;
  icon: string;
  route: string;
  badge?: string;
  featureFlag?: keyof FeatureFlags;
  roles?: string[]; // role-based access
}

// Dynamic Tab Bar
const DynamicTabBar: React.FC = () => {
  const { navigation, features, user } = useTenant();
  
  const visibleTabs = navigation.tabs.filter(tab => {
    // Feature flag check
    if (tab.featureFlag && !features[tab.featureFlag]) return false;
    
    // Role-based access
    if (tab.roles && !tab.roles.some(role => user.roles.includes(role))) return false;
    
    return true;
  });

  return (
    <IonTabBar>
      {visibleTabs.map(tab => (
        <IonTabButton key={tab.id} tab={tab.id} href={tab.route}>
          <IonIcon icon={tab.icon} />
          <IonLabel>{tab.label}</IonLabel>
          {tab.badge && <IonBadge>{tab.badge}</IonBadge>}
        </IonTabButton>
      ))}
    </IonTabBar>
  );
};
```

## Screen Configuration System

### Layout Configuration
```typescript
interface ScreenConfiguration {
  dashboard: DashboardLayout;
  listViews: ListViewConfig;
  detailViews: DetailViewConfig;
  forms: FormLayoutConfig;
}

interface DashboardLayout {
  widgets: DashboardWidget[];
  columns: number;
  refreshInterval?: number;
}

interface DashboardWidget {
  id: string;
  type: 'chart' | 'metric' | 'list' | 'calendar' | 'map';
  title: string;
  size: 'small' | 'medium' | 'large';
  position: { row: number; col: number };
  dataSource: string;
  refreshable: boolean;
  featureFlag?: keyof FeatureFlags;
}

// Configurable Dashboard
const ConfigurableDashboard: React.FC = () => {
  const { ui } = useTenant();
  const hasReports = useFeatureFlag('customReports');
  
  const availableWidgets = ui.screens.dashboard.widgets.filter(widget =>
    !widget.featureFlag || hasReports
  );

  return (
    <IonGrid>
      {availableWidgets.map(widget => (
        <IonCol key={widget.id} size={getColSize(widget.size)}>
          <DashboardWidget config={widget} />
        </IonCol>
      ))}
    </IonGrid>
  );
};
```

## Industry-Specific Customizations

### Healthcare Industry Example
```typescript
interface HealthcareSettings {
  hipaaMode: boolean;
  patientPortal: boolean;
  appointmentTypes: AppointmentType[];
  medicalForms: FormSchema[];
  providerDirectory: boolean;
  telemedicine: boolean;
}

// Healthcare-specific Navigation
const healthcareNavigation: TabConfig[] = [
  { id: 'patients', label: 'Patients', icon: 'people', route: '/patients' },
  { id: 'appointments', label: 'Schedule', icon: 'calendar', route: '/appointments' },
  { id: 'records', label: 'Records', icon: 'document-text', route: '/records', featureFlag: 'hipaaCompliance' },
  { id: 'billing', label: 'Billing', icon: 'card', route: '/billing', roles: ['admin', 'billing'] }
];

// Healthcare Dashboard Widgets
const healthcareWidgets: DashboardWidget[] = [
  { id: 'appointments-today', type: 'list', title: 'Today\'s Appointments', size: 'medium', position: { row: 1, col: 1 } },
  { id: 'patient-metrics', type: 'chart', title: 'Patient Metrics', size: 'large', position: { row: 1, col: 2 } },
  { id: 'compliance-status', type: 'metric', title: 'HIPAA Compliance', size: 'small', position: { row: 2, col: 1 } }
];
```

### Retail Industry Example
```typescript
interface RetailSettings {
  inventory: boolean;
  pos: boolean;
  loyaltyProgram: boolean;
  productCatalog: boolean;
  orderManagement: boolean;
}

const retailNavigation: TabConfig[] = [
  { id: 'products', label: 'Products', icon: 'storefront', route: '/products' },
  { id: 'orders', label: 'Orders', icon: 'receipt', route: '/orders' },
  { id: 'inventory', label: 'Inventory', icon: 'cube', route: '/inventory', featureFlag: 'inventoryManagement' },
  { id: 'customers', label: 'Customers', icon: 'people', route: '/customers' }
];
```

## Configuration Management

### Local Storage Strategy
```typescript
class ConfigurationManager {
  private static CACHE_KEY = 'tenant_config';
  private static CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

  static async getTenantConfig(tenantId: string): Promise<TenantConfig> {
    // Try cache first
    const cached = this.getCachedConfig(tenantId);
    if (cached && !this.isCacheExpired(cached)) {
      return cached.data;
    }

    // Fetch from server
    const config = await this.fetchConfigFromServer(tenantId);
    
    // Cache the result
    this.cacheConfig(tenantId, config);
    
    return config;
  }

  private static getCachedConfig(tenantId: string) {
    const cached = localStorage.getItem(`${this.CACHE_KEY}_${tenantId}`);
    return cached ? JSON.parse(cached) : null;
  }

  private static cacheConfig(tenantId: string, config: TenantConfig) {
    const cacheData = {
      data: config,
      timestamp: Date.now()
    };
    localStorage.setItem(`${this.CACHE_KEY}_${tenantId}`, JSON.stringify(cacheData));
  }
}
```

### Runtime Theme Updates
```typescript
// Live theme updates without app restart
export const useThemeUpdates = () => {
  const { tenantConfig } = useTenant();
  
  useEffect(() => {
    // Listen for configuration updates via WebSocket or polling
    const handleConfigUpdate = (newConfig: Partial<TenantConfig>) => {
      // Update theme variables in real-time
      if (newConfig.branding) {
        applyThemeVariables(newConfig.branding);
      }
      
      // Update feature flags
      if (newConfig.features) {
        updateFeatureFlags(newConfig.features);
      }
    };

    // WebSocket listener or polling mechanism
    const unsubscribe = subscribeToConfigUpdates(tenantConfig.tenantId, handleConfigUpdate);
    
    return unsubscribe;
  }, [tenantConfig.tenantId]);
};
```