import React, { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import PageHeader from '@/components/ui/PageHeader';
import QRCodeLibrary from '@/components/qrmanager/QRCodeLibrary';
import QRDeliveryCenter from '@/components/qrmanager/QRDeliveryCenter';
import CameraWasteDetection from '@/components/qrmanager/CameraWasteDetection';
import QRDashboard from '@/components/qrmanager/QRDashboard';
import { LayoutDashboard, QrCode, Send, Camera } from 'lucide-react';

export default function QRManagement() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [sendQR, setSendQR] = useState(null);

  const handleSendQR = (qr) => {
    setSendQR(qr);
    setActiveTab('delivery');
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader
          title="QR Code Management"
          description="Generate, distribute and track QR codes with AI-powered food waste detection"
        />

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-6">
            <TabsTrigger value="dashboard" className="flex items-center gap-2">
              <LayoutDashboard className="w-4 h-4" /> Dashboard
            </TabsTrigger>
            <TabsTrigger value="library" className="flex items-center gap-2">
              <QrCode className="w-4 h-4" /> QR Library
            </TabsTrigger>
            <TabsTrigger value="delivery" className="flex items-center gap-2">
              <Send className="w-4 h-4" /> Distribution
            </TabsTrigger>
            <TabsTrigger value="waste" className="flex items-center gap-2">
              <Camera className="w-4 h-4" /> Waste Detection
            </TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard">
            <QRDashboard />
          </TabsContent>

          <TabsContent value="library">
            <QRCodeLibrary onSendQR={handleSendQR} />
          </TabsContent>

          <TabsContent value="delivery">
            <QRDeliveryCenter preselectedQR={sendQR} />
          </TabsContent>

          <TabsContent value="waste">
            <CameraWasteDetection />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}