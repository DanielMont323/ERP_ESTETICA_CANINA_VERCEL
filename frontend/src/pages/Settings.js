import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { authAPI } from '../services/api';
import toast from 'react-hot-toast';
import {
  Users,
  User,
  Bell,
  Shield,
  Database,
  Save,
  Eye,
  EyeOff
} from 'lucide-react';

// Administración de usuarios (solo admin): crear cuentas y asignar contraseña nueva.
const UsuariosAdmin = () => {
  const [usuarios, setUsuarios] = useState([]);
  const [nuevo, setNuevo] = useState({ name: '', email: '', password: '', role: 'user' });
  const [guardando, setGuardando] = useState(false);
  const [restableciendo, setRestableciendo] = useState(null);
  const [passwordNueva, setPasswordNueva] = useState('');

  const cargar = async () => {
    try { setUsuarios((await authAPI.getUsers()).data.data); } catch { toast.error('No se pudo cargar la lista de usuarios'); }
  };
  useEffect(() => { cargar(); }, []);

  const crear = async e => {
    e.preventDefault();
    if (nuevo.password.length < 8) { toast.error('La contraseña debe tener al menos 8 caracteres'); return; }
    setGuardando(true);
    try {
      await authAPI.createUser(nuevo);
      toast.success(`Usuario ${nuevo.name} creado`);
      setNuevo({ name: '', email: '', password: '', role: 'user' });
      cargar();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo crear el usuario');
    } finally {
      setGuardando(false);
    }
  };

  const restablecer = async id => {
    if (passwordNueva.length < 8) { toast.error('La contraseña debe tener al menos 8 caracteres'); return; }
    try {
      const r = await authAPI.resetUserPassword(id, passwordNueva);
      toast.success(r.data.message);
      setRestableciendo(null);
      setPasswordNueva('');
      cargar();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo cambiar la contraseña');
    }
  };

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-medium text-gray-700 dark:text-dark-text">Usuarios del sistema</h3>
      <div className="divide-y divide-gray-200 dark:divide-dark-border border border-gray-200 dark:border-dark-border rounded-xl">
        {usuarios.map(u => (
          <div key={u._id} className="p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium text-gray-800 dark:text-dark-text">{u.name}</p>
                <p className="text-xs text-gray-500 dark:text-dark-textSecondary">
                  {u.email} · {u.role === 'admin' ? 'Administrador' : 'Usuario'}
                  {u.lockUntil && new Date(u.lockUntil) > new Date() && ' · Bloqueado temporalmente'}
                </p>
              </div>
              <button type="button" className="btn btn-secondary btn-sm"
                onClick={() => { setRestableciendo(restableciendo === u._id ? null : u._id); setPasswordNueva(''); }}>
                Asignar contraseña nueva
              </button>
            </div>
            {restableciendo === u._id && (
              <div className="flex flex-wrap gap-2">
                <input type="text" className="form-input flex-1 min-w-[12rem]" placeholder="Contraseña nueva (mínimo 8)"
                  value={passwordNueva} onChange={e => setPasswordNueva(e.target.value)} autoComplete="new-password" />
                <button type="button" className="btn btn-primary btn-sm" onClick={() => restablecer(u._id)}>Guardar</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <form onSubmit={crear} className="space-y-3 border border-gray-200 dark:border-dark-border rounded-xl p-4">
        <h4 className="font-medium text-gray-700 dark:text-dark-text">Crear usuario</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input className="form-input" placeholder="Nombre" required value={nuevo.name}
            onChange={e => setNuevo({ ...nuevo, name: e.target.value })} />
          <input className="form-input" type="email" placeholder="correo@ejemplo.com" required value={nuevo.email}
            onChange={e => setNuevo({ ...nuevo, email: e.target.value })} />
          <input className="form-input" type="text" placeholder="Contraseña (mínimo 8)" required value={nuevo.password}
            onChange={e => setNuevo({ ...nuevo, password: e.target.value })} autoComplete="new-password" />
          <select className="form-input" value={nuevo.role} onChange={e => setNuevo({ ...nuevo, role: e.target.value })}>
            <option value="user">Usuario (ventas, clientes, mascotas)</option>
            <option value="admin">Administrador (todo)</option>
          </select>
        </div>
        <button type="submit" className="btn btn-primary btn-md" disabled={guardando}>
          {guardando ? 'Creando...' : 'Crear usuario'}
        </button>
      </form>
    </div>
  );
};

const Settings = () => {
  const { user, changePassword } = useAuth();
  const [activeTab, setActiveTab] = useState('profile');
  const [showPassword, setShowPassword] = useState(false);
  const [formData, setFormData] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });

  const [cambiando, setCambiando] = useState(false);

  // Antes este botón decía "Contraseña actualizada" sin cambiar nada; ahora llama al servidor.
  const handlePasswordChange = async (e) => {
    e.preventDefault();
    if (formData.newPassword !== formData.confirmPassword) {
      toast.error('Las contraseñas no coinciden');
      return;
    }
    if (formData.newPassword.length < 8) {
      toast.error('La contraseña nueva debe tener al menos 8 caracteres');
      return;
    }
    setCambiando(true);
    const r = await changePassword(formData.currentPassword, formData.newPassword);
    setCambiando(false);
    if (r.success) {
      toast.success('Contraseña actualizada. Las demás sesiones abiertas se cerraron.');
      setFormData({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } else {
      toast.error(r.message);
    }
  };

  const tabs = [
    { id: 'profile', name: 'Perfil', icon: User },
    ...(user?.role === 'admin' ? [{ id: 'users', name: 'Usuarios', icon: Users }] : []),
    { id: 'notifications', name: 'Notificaciones', icon: Bell },
    { id: 'security', name: 'Seguridad', icon: Shield },
    { id: 'data', name: 'Datos', icon: Database },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-gray-700 dark:text-dark-textSecondary dark:text-dark-text">Configuración</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-dark-textSecondary">
          Gestiona la configuración del sistema
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Sidebar */}
        <div className="lg:col-span-1">
          <nav className="space-y-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                    activeTab === tab.id
                      ? 'bg-primary-100 text-primary-700 border-r-2 border-primary-700'
                      : 'text-gray-600 dark:text-dark-textSecondary hover:bg-gray-50 dark:bg-dark-surface hover:text-gray-700 dark:text-dark-textSecondary dark:text-dark-text'
                  }`}
                >
                  <Icon className="mr-3 h-5 w-5 flex-shrink-0" />
                  {tab.name}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Content */}
        <div className="lg:col-span-3">
          <div className="card">
            <div className="card-body">
              {/* Profile Tab */}
              {activeTab === 'profile' && (
                <div className="space-y-6">
                  <h3 className="text-lg font-medium text-gray-700 dark:text-dark-textSecondary dark:text-dark-text">Información del Perfil</h3>
                  
                  <div className="flex items-center space-x-4">
                    <div className="h-16 w-16 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center shadow-lg">
                      <span className="text-white dark:bg-dark-card text-xl font-medium">
                        {user?.name?.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div>
                      <h4 className="text-lg font-medium text-gray-700 dark:text-dark-textSecondary dark:text-dark-text">{user?.name}</h4>
                      <p className="text-sm text-gray-500 dark:text-dark-textSecondary">{user?.email}</p>
                      <p className="text-sm text-gray-500 dark:text-dark-textSecondary">Rol: {user?.role}</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="form-label">Nombre</label>
                      <input
                        type="text"
                        defaultValue={user?.name}
                        className="form-input"
                      />
                    </div>
                    <div>
                      <label className="form-label">Email</label>
                      <input
                        type="email"
                        defaultValue={user?.email}
                        className="form-input"
                      />
                    </div>
                  </div>

                  <button className="btn btn-primary btn-md hover:scale-105 transition-transform">
                    <Save className="h-4 w-4 mr-2" />
                    Guardar Cambios
                  </button>
                </div>
              )}

              {/* Notifications Tab */}
              {activeTab === 'notifications' && (
                <div className="space-y-6">
                  <h3 className="text-lg font-medium text-gray-700 dark:text-dark-textSecondary dark:text-dark-text">Preferencias de Notificación</h3>
                  
                  <div className="space-y-4">
                    <label className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-gray-700 dark:text-dark-textSecondary dark:text-dark-text">Notificaciones de bajo stock</p>
                        <p className="text-sm text-gray-500 dark:text-dark-textSecondary">Recibir alertas cuando el stock esté por debajo del mínimo</p>
                      </div>
                      <input type="checkbox" defaultChecked className="h-4 w-4 text-brand-burgundy" />
                    </label>

                    <label className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-gray-700 dark:text-dark-textSecondary dark:text-dark-text">Recordatorios vencidos</p>
                        <p className="text-sm text-gray-500 dark:text-dark-textSecondary">Alertas sobre recordatorios que han pasado su fecha</p>
                      </div>
                      <input type="checkbox" defaultChecked className="h-4 w-4 text-brand-burgundy" />
                    </label>

                    <label className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-gray-700 dark:text-dark-textSecondary dark:text-dark-text">Cuentas por pagar vencidas</p>
                        <p className="text-sm text-gray-500 dark:text-dark-textSecondary">Notificaciones sobre pagos vencidos</p>
                      </div>
                      <input type="checkbox" defaultChecked className="h-4 w-4 text-brand-burgundy" />
                    </label>

                    <label className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-gray-700 dark:text-dark-textSecondary dark:text-dark-text">Resumen diario</p>
                        <p className="text-sm text-gray-500 dark:text-dark-textSecondary">Resumen de ventas y actividades del día</p>
                      </div>
                      <input type="checkbox" className="h-4 w-4 text-brand-burgundy" />
                    </label>
                  </div>
                </div>
              )}

              {activeTab === 'users' && user?.role === 'admin' && <UsuariosAdmin />}

              {/* Security Tab */}
              {activeTab === 'security' && (
                <div className="space-y-6">
                  <h3 className="text-lg font-medium text-gray-700 dark:text-dark-textSecondary dark:text-dark-text">Cambiar Contraseña</h3>
                  
                  <form onSubmit={handlePasswordChange} className="space-y-4">
                    <div>
                      <label className="form-label">Contraseña Actual</label>
                      <input
                        type="password"
                        value={formData.currentPassword}
                        onChange={(e) => setFormData({...formData, currentPassword: e.target.value})}
                        className="form-input"
                        required
                      />
                    </div>

                    <div>
                      <label className="form-label">Nueva Contraseña</label>
                      <div className="relative">
                        <input
                          type={showPassword ? 'text' : 'password'}
                          value={formData.newPassword}
                          onChange={(e) => setFormData({...formData, newPassword: e.target.value})}
                          className="form-input pr-10"
                          required
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute inset-y-0 right-0 pr-3 flex items-center"
                        >
                          {showPassword ? (
                            <EyeOff className="h-5 w-5 text-gray-400 dark:text-dark-textSecondary" />
                          ) : (
                            <Eye className="h-5 w-5 text-gray-400 dark:text-dark-textSecondary" />
                          )}
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="form-label">Confirmar Nueva Contraseña</label>
                      <input
                        type="password"
                        value={formData.confirmPassword}
                        onChange={(e) => setFormData({...formData, confirmPassword: e.target.value})}
                        className="form-input"
                        required
                      />
                    </div>

                    <button type="submit" disabled={cambiando} className="btn btn-primary btn-md hover:scale-105 transition-transform">
                      {cambiando ? 'Actualizando...' : 'Actualizar Contraseña'}
                    </button>
                  </form>
                </div>
              )}

              {/* Data Tab */}
              {activeTab === 'data' && (
                <div className="space-y-6">
                  <h3 className="text-lg font-medium text-gray-700 dark:text-dark-textSecondary dark:text-dark-text">Gestión de Datos</h3>
                  
                  <div className="space-y-4">
                    <div className="border border-gray-200 dark:border-dark-border rounded-xl p-4 hover:shadow-md transition-shadow">
                      <h4 className="font-medium text-gray-700 dark:text-dark-textSecondary dark:text-dark-text mb-2">Exportar Datos</h4>
                      <p className="text-sm text-gray-500 dark:text-dark-textSecondary mb-4">Descarga todos tus datos en formato CSV</p>
                      <button className="btn btn-secondary btn-md hover:scale-105 transition-transform">
                        <Database className="h-4 w-4 mr-2" />
                        Exportar Datos
                      </button>
                    </div>

                    <div className="border border-gray-200 dark:border-dark-border rounded-xl p-4 hover:shadow-md transition-shadow">
                      <h4 className="font-medium text-gray-700 dark:text-dark-textSecondary dark:text-dark-text mb-2">Respaldo de Base de Datos</h4>
                      <p className="text-sm text-gray-500 dark:text-dark-textSecondary mb-4">Crea un respaldo completo de la base de datos</p>
                      <button className="btn btn-secondary btn-md hover:scale-105 transition-transform">
                        <Database className="h-4 w-4 mr-2" />
                        Crear Respaldo
                      </button>
                    </div>

                    <div className="border border-danger-200 rounded-xl p-4 hover:shadow-md transition-shadow">
                      <h4 className="font-medium text-danger-900 mb-2">Zona de Peligro</h4>
                      <p className="text-sm text-danger-500 mb-4">Estas acciones son irreversibles</p>
                      <button className="btn btn-danger btn-md hover:scale-105 transition-transform">
                        Eliminar Todos los Datos
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;
