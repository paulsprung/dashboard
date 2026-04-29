export type PanelStatus = 'online' | 'warning' | 'offline' | 'idle';

export type DashboardPanel = {
  id: string;
  title: string;
  description: string;
  status: PanelStatus;
  metric: string;
  tags: string[];
};

export type DashboardAction = {
  id: string;
  label: string;
  hint: string;
  intent?: 'primary' | 'danger';
};

export const dashboardPanels: DashboardPanel[] = [
  { id: 'homeserver', title: 'Homeserver Status', description: 'Core node handling backup jobs, media transcoding and private services.', status: 'online', metric: 'Uptime 18d 07h', tags: ['CPU 29%', 'RAM 54%'] },
  { id: 'proxmox', title: 'Proxmox Cluster', description: 'Hypervisor orchestration and host health for virtualization workloads.', status: 'online', metric: '2 nodes healthy', tags: ['HA active', 'No alerts'] },
  { id: 'vms', title: 'Virtual Machines', description: 'Critical VM pool including Windows workstation and Linux utility servers.', status: 'warning', metric: '6 running / 7 total', tags: ['1 paused', 'I/O nominal'] },
  { id: 'smartplugs', title: 'Smart Plugs', description: 'Remote power relay overview for lab equipment and edge devices.', status: 'online', metric: '5 active switches', tags: ['Load 1.2kW', 'Auto rules on'] },
  { id: 'cloud', title: 'Cloud Storage', description: 'Synced project assets and encrypted snapshots across cloud buckets.', status: 'idle', metric: '84% synced', tags: ['Last sync 4m', 'Queue low'] },
  { id: 'remote', title: 'Remote Access', description: 'Gateway for secure ingress to RDP and SSH entry points.', status: 'online', metric: 'Tunnel stable', tags: ['Latency 26ms', '2 sessions'] }
];

export const quickActions: DashboardAction[] = [
  { id: 'turn-on-homeserver', label: 'Turn on Homeserver', hint: 'Mock action only', intent: 'primary' },
  { id: 'shutdown-homeserver', label: 'Shutdown Homeserver', hint: 'Mock action only', intent: 'danger' },
  { id: 'open-proxmox', label: 'Open Proxmox', hint: 'Mock action only' },
  { id: 'open-windows-vm', label: 'Open Windows VM', hint: 'Mock action only' },
  { id: 'open-files', label: 'Open Files', hint: 'Mock action only' },
  { id: 'open-rdp-ssh', label: 'Open RDP/SSH', hint: 'Mock action only' }
];

export const activityMock = [
  'Vault-authenticated session started from admin workstation',
  'Nightly backup snapshot completed successfully',
  'VM WIN-OPS reboot scheduled for maintenance window',
  'Remote SSH policy synced with baseline profile'
];
