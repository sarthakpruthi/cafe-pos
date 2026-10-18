import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, LoginPage, RequireRole, useAuth } from './staff/auth';
import StaffLayout from './staff/Layout';
import TablesPage from './staff/TablesPage';
import TablePage from './staff/TablePage';
import MenuManager from './staff/MenuManager';
import Reports from './staff/Reports';
import UsersPage from './staff/UsersPage';
import QrPage from './staff/QrPage';
import AuditPage from './staff/AuditPage';
import CustomerPage from './customer/CustomerPage';

function Home() {
  const { user, loading } = useAuth();
  if (loading) return null;
  return <Navigate to={!user ? '/login' : user.role === 'MANAGER' ? '/manager/tables' : '/staff/tables'} replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/t/:qrToken" element={<CustomerPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/manager" element={<RequireRole role="MANAGER"><StaffLayout /></RequireRole>}>
          <Route index element={<Navigate to="tables" replace />} />
          <Route path="tables" element={<TablesPage />} />
          <Route path="tables/:tableId" element={<TablePage />} />
          <Route path="menu" element={<MenuManager />} />
          <Route path="reports" element={<Reports />} />
          <Route path="staff" element={<UsersPage />} />
          <Route path="qr-codes" element={<QrPage />} />
          <Route path="audit" element={<AuditPage />} />
        </Route>
        <Route path="/staff" element={<RequireRole role="STAFF"><StaffLayout /></RequireRole>}>
          <Route index element={<Navigate to="tables" replace />} />
          <Route path="tables" element={<TablesPage />} />
          <Route path="tables/:tableId" element={<TablePage />} />
        </Route>
        <Route path="*" element={<Home />} />
      </Routes>
    </AuthProvider>
  );
}
