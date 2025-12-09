"use client";

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription, DialogClose } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Plus, Edit, Trash, Eye } from 'lucide-react';
import { db } from '@/lib/firebase'; // Adapt this import path as needed
import { collection, query, where, getDocs, updateDoc, doc, setDoc } from 'firebase/firestore';

interface Department {
  id: string;
  name: string;
  name_ml: string;
  description: string;
  description_ml: string;
  doctors: string[];
  icon: string;
  isDeleted?: boolean;
}

export default function DepartmentsPage() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [openEditModal, setOpenEditModal] = useState(false);
  const [selectedDepartment, setSelectedDepartment] = useState<Department | null>(null);
  const [formVals, setFormVals] = useState<Omit<Department, 'id' | 'doctors' | 'isDeleted'> & { id?: string }>({
    name: '', name_ml: '', description: '', description_ml: '', icon: '', id: ''
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const fetchDepartments = async () => {
      setLoading(true);
      const snapshot = await getDocs(collection(db, 'master-departments'));
      const result: Department[] = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as Department))
        .filter(dept => !dept.isDeleted); // Show if missing or false
      setDepartments(result);
      setLoading(false);
    };
    fetchDepartments();
  }, []);

  const openAddDialog = () => {
    setSelectedDepartment(null);
    setFormVals({ name: '', name_ml: '', description: '', description_ml: '', icon: '', id: '' });
    setOpenEditModal(true);
  };

  const openEditDialog = (dept: Department) => {
    setSelectedDepartment(dept);
    setFormVals({ ...dept });
    setOpenEditModal(true);
  };

  const handleSoftDelete = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this department?')) return;
    await updateDoc(doc(db, 'master-departments', id), { isDeleted: true });
    setDepartments(depts => depts.filter(d => d.id !== id));
  };

  const handleSave = async () => {
    const { name, name_ml, description, description_ml, icon, id } = formVals;
    if (!name || !name_ml || !description || !description_ml || !icon) {
      alert('All fields (both languages + icon) are required.');
      return;
    }
    setSaving(true);
    if (selectedDepartment) {
      // EDIT
      await updateDoc(doc(db, 'master-departments', selectedDepartment.id), {
        name, name_ml, description, description_ml, icon
      });
      setDepartments(depts => depts.map(d => d.id === selectedDepartment.id ? { ...d, name, name_ml, description, description_ml, icon } : d));
    } else {
      // ADD
      const ref = doc(collection(db, 'master-departments'));
      await updateDoc(ref, {
        name, name_ml, description, description_ml, icon, doctors: [], isDeleted: false
      }).catch(async (e) => {
        // Fallback: If doc does not exist, create it
        await setDoc(ref, { name, name_ml, description, description_ml, icon, doctors: [], isDeleted: false });
      });
      setDepartments(depts => [...depts, { id: ref.id, name, name_ml, description, description_ml, icon, doctors: [] }]);
    }
    setSaving(false);
    setOpenEditModal(false);
    setSelectedDepartment(null);
  };

  return (
    <div className="max-w-5xl mx-auto py-10">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Departments</CardTitle>
          <Button onClick={openAddDialog}><Plus className="w-4 h-4 mr-2" />Add Department</Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Icon</TableHead>
                <TableHead>Name (EN)</TableHead>
                <TableHead>Name (ML)</TableHead>
                <TableHead>Description (EN)</TableHead>
                <TableHead>Description (ML)</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={6}>Loading...</TableCell></TableRow>
              ) : departments.length === 0 ? (
                <TableRow><TableCell colSpan={6}>No departments found.</TableCell></TableRow>
              ) : (
                departments.map((dept) => (
                  <TableRow key={dept.id}>
                    <TableCell>{dept.icon}</TableCell>
                    <TableCell>{dept.name}</TableCell>
                    <TableCell>{dept.name_ml}</TableCell>
                    <TableCell>{dept.description}</TableCell>
                    <TableCell>{dept.description_ml}</TableCell>
                    <TableCell className="flex gap-2">
                      <Button size="icon" variant="ghost" onClick={() => openEditDialog(dept)}><Edit className="w-4 h-4" /></Button>
                      <Button size="icon" variant="ghost" /*onClick={() => view logic here }*/><Eye className="w-4 h-4" /></Button>
                      <Button size="icon" variant="destructive" onClick={() => handleSoftDelete(dept.id)}><Trash className="w-4 h-4" /></Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {/* ADD/EDIT DIALOG */}
      <Dialog open={openEditModal} onOpenChange={setOpenEditModal}>
        <DialogContent className="max-w-lg w-full">
          <DialogHeader>
            <DialogTitle>{selectedDepartment ? 'Edit Department' : 'Add Department'}</DialogTitle>
            <DialogDescription>
              Enter the department details in both English and Malayalam.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Input placeholder="Name (English)" value={formVals.name} onChange={e => setFormVals(f => ({ ...f, name: e.target.value }))} />
            <Input placeholder="Name (Malayalam)" value={formVals.name_ml} onChange={e => setFormVals(f => ({ ...f, name_ml: e.target.value }))} />
            <Textarea placeholder="Description (English)" value={formVals.description} onChange={e => setFormVals(f => ({ ...f, description: e.target.value }))} />
            <Textarea placeholder="Description (Malayalam)" value={formVals.description_ml} onChange={e => setFormVals(f => ({ ...f, description_ml: e.target.value }))} />
            <Input placeholder="Icon (e.g. Stethoscope)" value={formVals.icon} onChange={e => setFormVals(f => ({ ...f, icon: e.target.value }))} />
          </div>
          <DialogFooter>
            <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
