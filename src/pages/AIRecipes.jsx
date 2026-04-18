import React from 'react';
import PageHeader from '@/components/ui/PageHeader';
import AIRecipeGenerator from '@/components/ai/AIRecipeGenerator';
import { Sparkles } from 'lucide-react';

export default function AIRecipes() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1400px] mx-auto">
        <PageHeader 
          title="AI Recipe Generator" 
          description="Generate new recipes based on available inventory and food trends"
        >
          <div className="flex items-center gap-2 text-purple-600">
            <Sparkles className="w-5 h-5" />
            <span className="text-sm font-medium">Powered by AI</span>
          </div>
        </PageHeader>

        <AIRecipeGenerator />
      </div>
    </div>
  );
}